import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { requireAuth } from '../middleware/auth.js'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''
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
   * Telegram webhook — when you reply to a user message in TG,
   * this saves the reply so the user sees it in the chat widget.
   */
  app.post('/webhook', async (req, reply) => {
    const token = req.headers['x-telegram-bot-api-secret-token']
    if (!TELEGRAM_WEBHOOK_SECRET || token !== TELEGRAM_WEBHOOK_SECRET) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const body = req.body as any
    const message = body?.message
    if (!message) return { ok: true }

    if (String(message.chat?.id) !== TELEGRAM_CHAT_ID) return { ok: true }

    const replyText = message.text
    if (!replyText) return { ok: true }

    const replyTo = message.reply_to_message
    if (!replyTo) return { ok: true }

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
