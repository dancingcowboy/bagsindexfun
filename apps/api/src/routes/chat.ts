import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { requireAuth } from '../middleware/auth.js'
import { handleMenuCommand, handleCallback } from '../lib/telegram-menu.js'
import { answerCallbackQuery } from '../lib/telegram-api.js'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
// Support chat + DM-forward destination. Intentionally separate from
// TELEGRAM_CHAT_ID (which is the system-notices / reshuffle group), so
// user-facing chat doesn't mix with automated protocol updates.
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_SUPPORT_CHAT_ID || ''
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ''

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')
}

export async function chatRoutes(app: FastifyInstance) {
  /**
   * GET /chat/messages
   * List the authenticated user's chat messages.
   */
  app.get('/messages', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const messages = await db.chatMessage.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: {
          id: true,
          direction: true,
          message: true,
          createdAt: true,
        },
      })
      return { success: true, data: messages }
    } catch (err) {
      app.log.error(err, 'Failed to load chat messages')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /chat/send
   * User sends a support message. Saved to DB + forwarded to Telegram.
   */
  app.post('/send', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const { message } = req.body as { message?: string }
      if (!message || typeof message !== 'string' || !message.trim()) {
        return reply.status(400).send({ error: 'Message is required' })
      }
      const trimmed = message.trim().slice(0, 2000)

      const user = await db.user.findUnique({
        where: { id: userId },
        select: { walletAddress: true },
      })
      const wallet = user?.walletAddress
        ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
        : 'unknown'

      const chatMsg = await db.chatMessage.create({
        data: { userId, direction: 'user', message: trimmed },
      })

      // Forward to Telegram
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        const telegramText = `💬 *Bags Index Support*\n\n*From:* ${escapeMarkdown(wallet)}\n*User ID:* \`${userId}\`\n\n${escapeMarkdown(trimmed)}`
        try {
          const res = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: telegramText,
                parse_mode: 'MarkdownV2',
              }),
            },
          )
          const data = (await res.json()) as { ok?: boolean; result?: { message_id?: number } }
          if (data.ok && data.result?.message_id) {
            await db.chatMessage.update({
              where: { id: chatMsg.id },
              data: { telegramMessageId: data.result.message_id },
            })
          }
        } catch {
          // Telegram delivery failed — message is still saved
        }
      }

      return { success: true, data: { id: chatMsg.id, createdAt: chatMsg.createdAt } }
    } catch (err) {
      app.log.error(err, 'Failed to send chat message')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /chat/webhook
   * Telegram webhook — handles two kinds of updates:
   *   1. DM to the bot from any user → forwarded into the support group
   *      so admins see it alongside dashboard chat messages.
   *   2. Reply inside the support group to a forwarded dashboard message
   *      → saved as a `support` chat message so the user sees it in the
   *      in-dashboard chat widget.
   */
  app.post('/webhook', async (req, reply) => {
    const token = req.headers['x-telegram-bot-api-secret-token']
    if (!TELEGRAM_WEBHOOK_SECRET || token !== TELEGRAM_WEBHOOK_SECRET) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const body = req.body as any

    // ── Callback queries (inline keyboard taps) ──────────────────
    const cbq = body?.callback_query
    if (cbq) {
      try {
        const chatId = BigInt(cbq.message?.chat?.id ?? cbq.from?.id ?? 0)
        const messageId = cbq.message?.message_id as number | undefined
        const data = cbq.data as string | undefined
        if (chatId && messageId && data) {
          await handleCallback(data, chatId, messageId, cbq.id)
        } else {
          await answerCallbackQuery(cbq.id)
        }
      } catch (err) {
        app.log.error({ err }, '[chat/webhook] callback_query handler failed')
        try { await answerCallbackQuery(cbq.id, 'Something went wrong', true) } catch {}
      }
      return { ok: true }
    }

    const message = body?.message
    if (!message) return { ok: true }

    // Case 0: DM to the bot that matches a live opt-in link code.
    // `/start CODE` (Telegram's standard deep-link handoff) or a bare
    // 6-digit message binds this chat to the user who generated the code
    // in the dashboard. Must run BEFORE the Case 1 forward-to-support
    // block so link attempts don't spam the support group.
    if (message.chat?.type === 'private' && TELEGRAM_BOT_TOKEN) {
      const text = String(message.text ?? '').trim()
      const codeMatch = text.match(/^(?:\/start\s+)?(\d{6})$/)
      if (codeMatch) {
        const code = codeMatch[1]
        const chatId = BigInt(message.chat.id)
        const dmSend = async (body: string) => {
          await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId.toString(),
                text: body,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
              }),
            },
          ).catch((err) => app.log.error({ err }, '[chat/link] reply send failed'))
        }
        try {
          const user = await db.user.findFirst({
            where: {
              telegramLinkCode: code,
              telegramLinkCodeExpiresAt: { gt: new Date() },
            },
            select: { id: true, walletAddress: true },
          })
          if (user) {
            await db.user.update({
              where: { id: user.id },
              data: {
                telegramChatId: chatId,
                telegramNotifyEnabled: true,
                telegramLinkCode: null,
                telegramLinkCodeExpiresAt: null,
              },
            })
            const short = `${user.walletAddress.slice(0, 6)}…${user.walletAddress.slice(-4)}`
            await dmSend(
              `✅ Linked to wallet <code>${short}</code>\n\nYou'll now get DMs when your vaults trade. Manage in the dashboard.`,
            )
            return { ok: true }
          }
          // /start with a code that doesn't resolve — tell the user so
          // they don't wait forever. Bare 6-digit with no match falls
          // through to the support-forward path (could be a real msg).
          if (text.startsWith('/start')) {
            await dmSend('⚠️ That link code is invalid or expired. Generate a new one in the dashboard.')
            return { ok: true }
          }
        } catch (err) {
          app.log.error({ err }, '[chat/link] code-match branch failed')
          // fall through to the normal forward path on any error
        }
      }
    }

    // ── /menu command for linked users ─────────────────────────────
    if (message.chat?.type === 'private') {
      const text = String(message.text ?? '').trim()
      if (/^\/menu$/i.test(text) || /^\/start$/i.test(text)) {
        try {
          await handleMenuCommand(BigInt(message.chat.id))
        } catch (err) {
          app.log.error({ err }, '[chat/webhook] /menu handler failed')
        }
        return { ok: true }
      }
    }

    // Case 1: DM to the bot — forward the raw message into the support
    // group and persist a mapping from the forwarded message's id in the
    // group to the DM chat id. The mapping is the authoritative route-
    // back channel: it works even when the user has forward-privacy
    // enabled and Telegram strips `forward_from` from the group copy.
    if (
      message.chat?.type === 'private' &&
      TELEGRAM_BOT_TOKEN &&
      TELEGRAM_CHAT_ID
    ) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/forwardMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: TELEGRAM_CHAT_ID,
              from_chat_id: message.chat.id,
              message_id: message.message_id,
            }),
          },
        )
        const data = (await res.json()) as {
          ok?: boolean
          result?: { message_id?: number }
          description?: string
        }
        if (data.ok && data.result?.message_id) {
          await db.telegramDmForward.create({
            data: {
              groupMessageId: data.result.message_id,
              dmChatId: BigInt(message.chat.id),
            },
          })
        } else {
          app.log.error({ data }, 'Telegram forwardMessage rejected')
        }
      } catch (err) {
        app.log.error({ err }, 'Failed to forward Telegram DM to support group')
      }
      return { ok: true }
    }

    // Case 2: reply inside the support group → route back to the dashboard
    // user or DM sender whose message this is replying to.
    if (String(message.chat?.id) !== TELEGRAM_CHAT_ID) return { ok: true }

    const replyText = message.text
    if (!replyText) return { ok: true }

    const replyTo = message.reply_to_message
    if (!replyTo) return { ok: true }

    // Case 2a: the reply is to a forwarded DM (Case 1). Prefer the DB
    // mapping we wrote when forwarding — it's the only source that
    // survives Telegram's forward-privacy setting. Fall back to the
    // `forward_from` / `forward_origin.sender_user` metadata only for
    // legacy rows that pre-date the mapping table.
    const mapping = replyTo.message_id
      ? await db.telegramDmForward.findUnique({
          where: { groupMessageId: replyTo.message_id },
        })
      : null
    const forwardOrigin = replyTo.forward_origin as
      | { type: string; sender_user?: { id: number } }
      | undefined
    let forwardedFromId: number | undefined
    if (mapping) {
      forwardedFromId = Number(mapping.dmChatId)
    } else if (replyTo.forward_from?.id) {
      forwardedFromId = replyTo.forward_from.id
    } else if (forwardOrigin?.type === 'user') {
      forwardedFromId = forwardOrigin.sender_user?.id
    }

    if (forwardedFromId && TELEGRAM_BOT_TOKEN) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: forwardedFromId,
              text: replyText,
            }),
          },
        )
        const data = (await res.json()) as { ok?: boolean; description?: string }
        if (!data.ok) {
          app.log.error({ data }, 'Failed to deliver group reply to DM sender')
          // Let the admin know their reply didn't land, threaded under
          // their own message so it's easy to spot in the group.
          await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                reply_to_message_id: message.message_id,
                text: `⚠️ Couldn't deliver reply: ${data.description ?? 'unknown error'}`,
              }),
            },
          ).catch(() => {})
        }
      } catch (err) {
        app.log.error({ err }, 'Failed to deliver group reply to DM sender')
      }
      return { ok: true }
    }

    // Case 2b: legacy dashboard chat reply — the original support message
    // was sent via sendMessage (not forwardMessage) and encodes the
    // internal User ID in its text. Extract it and save the reply.
    const originalText = replyTo.text || ''
    const userIdMatch = originalText.match(/User ID:\s*(\S+)/)
    if (!userIdMatch) return { ok: true }

    const userId = userIdMatch[1]
    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) return { ok: true }

    await db.chatMessage.create({
      data: {
        userId,
        direction: 'support',
        message: replyText.slice(0, 2000),
        telegramMessageId: message.message_id,
      },
    })

    return { ok: true }
  })
}
