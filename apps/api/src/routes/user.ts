import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { db } from '@bags-index/db'
import { requireAuth } from '../middleware/auth.js'

const LINK_CODE_TTL_MS = 10 * 60 * 1000

/**
 * Telegram linking lives under the user's account — the dashboard lets each
 * authenticated user opt into DM notifications through @bagsindexbot.
 * Auth first, ownership implicit (everything scoped to authUser.userId).
 */
export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  /**
   * POST /user/telegram/link-code
   * Generate a fresh 6-digit OTP (10-min expiry). User pastes it / sends
   * `/start CODE` to the bot to complete the link.
   */
  app.post('/telegram/link-code', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      // crypto.randomInt is uniform; padStart covers leading-zero codes.
      const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
      const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS)
      await db.user.update({
        where: { id: userId },
        data: {
          telegramLinkCode: code,
          telegramLinkCodeExpiresAt: expiresAt,
        },
      })
      const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'bagsindexbot'
      return {
        success: true,
        data: {
          code,
          expiresAt: expiresAt.toISOString(),
          deepLink: `https://t.me/${botUsername}?start=${code}`,
          botUsername,
        },
      }
    } catch (err) {
      req.log.error({ err }, '[user/telegram] link-code failed')
      return reply.status(500).send({ success: false, error: 'Failed to create link code' })
    }
  })

  /**
   * DELETE /user/telegram
   * Unlink the Telegram chat. Clears chatId + disables notifications.
   */
  app.delete('/telegram', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      await db.user.update({
        where: { id: userId },
        data: {
          telegramChatId: null,
          telegramNotifyEnabled: false,
          telegramLinkCode: null,
          telegramLinkCodeExpiresAt: null,
        },
      })
      return { success: true, data: { linked: false, enabled: false } }
    } catch (err) {
      req.log.error({ err }, '[user/telegram] unlink failed')
      return reply.status(500).send({ success: false, error: 'Failed to unlink' })
    }
  })

  /**
   * PUT /user/telegram/enabled   { enabled: boolean }
   * Flip the opt-in without unlinking, so the user keeps their chatId bound.
   */
  app.put<{ Body: { enabled?: unknown } }>('/telegram/enabled', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const enabled = req.body?.enabled === true
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { telegramChatId: true },
      })
      if (!user?.telegramChatId) {
        return reply.status(400).send({ success: false, error: 'Telegram is not linked' })
      }
      await db.user.update({
        where: { id: userId },
        data: { telegramNotifyEnabled: enabled },
      })
      return { success: true, data: { linked: true, enabled } }
    } catch (err) {
      req.log.error({ err }, '[user/telegram] toggle failed')
      return reply.status(500).send({ success: false, error: 'Failed to update' })
    }
  })

  /**
   * GET /user/telegram/status
   * Dashboard polls this during linking (every 3s) and on mount.
   */
  app.get('/telegram/status', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const user = await db.user.findUnique({
        where: { id: userId },
        select: {
          telegramChatId: true,
          telegramNotifyEnabled: true,
          telegramLinkCodeExpiresAt: true,
        },
      })
      return {
        success: true,
        data: {
          linked: !!user?.telegramChatId,
          enabled: !!user?.telegramNotifyEnabled,
          pendingCodeExpiresAt: user?.telegramLinkCodeExpiresAt?.toISOString() ?? null,
        },
      }
    } catch (err) {
      req.log.error({ err }, '[user/telegram] status failed')
      return reply.status(500).send({ success: false, error: 'Failed to load status' })
    }
  })
}
