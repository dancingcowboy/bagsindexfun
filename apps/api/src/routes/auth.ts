import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { loginSchema, RISK_TIERS } from '@bags-index/shared'
import { verifyPrivyToken, requireAuth, getPrivy } from '../middleware/auth.js'
import { createSolanaServerWallet } from '@bags-index/solana'
import { redis } from '../queue/redis.js'

const TOKEN_DENY_PREFIX = 'jwt:deny:'
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days — matches JWT expiry

export async function authRoutes(app: FastifyInstance) {
  /**
   * POST /auth/login
   * Verify Privy token, upsert user, create sub-wallet on first login.
   */
  app.post('/login', async (req, reply) => {
    try {
      const body = loginSchema.parse(req.body)
      const claims = await verifyPrivyToken(body.privyToken)
      const fullUser = await getPrivy().getUser(claims.userId)

      // Find a Solana wallet (linked external or embedded)
      const solanaAccount = (fullUser.linkedAccounts || []).find(
        (a: any) => a.type === 'wallet' && (a.chainType === 'solana' || a.walletClientType?.includes('solana')),
      ) as any
      const walletAddress = solanaAccount?.address || (fullUser as any).wallet?.address
      if (!walletAddress) {
        return reply.status(400).send({ error: 'No wallet linked to Privy account' })
      }

      // Launch allowlist — env vars (LAUNCH_ALLOWED_WALLETS, ADMIN_WALLETS)
      // and DB whitelist table both grant access. Everyone else gets
      // WALLET_NOT_ALLOWED so the frontend shows "coming soon".
      const envAllowed = new Set(
        [
          ...(process.env.LAUNCH_ALLOWED_WALLETS || '').split(','),
          ...(process.env.ADMIN_WALLETS || '').split(','),
        ]
          .map((w) => w.trim())
          .filter(Boolean),
      )
      const dbWhitelisted = await db.walletWhitelist.findUnique({
        where: { walletAddress },
        select: { id: true },
      })
      if (envAllowed.size > 0 && !envAllowed.has(walletAddress) && !dbWhitelisted) {
        app.log.warn({ walletAddress }, 'WALLET_NOT_ALLOWED')
        return reply.status(403).send({ error: 'WALLET_NOT_ALLOWED' })
      }

      // Upsert user
      const user = await db.user.upsert({
        where: { privyUserId: claims.userId },
        update: { lastSeenAt: new Date() },
        create: {
          privyUserId: claims.userId,
          walletAddress,
        },
        include: { subWallets: true },
      })

      // Create one Privy server wallet per tier on first login
      const existingTiers = new Set(user.subWallets.map((w) => w.riskTier))
      for (const tier of RISK_TIERS) {
        if (!existingTiers.has(tier)) {
          const { walletId, address } = await createSolanaServerWallet()
          await db.subWallet.create({
            data: {
              userId: user.id,
              riskTier: tier,
              privyWalletId: walletId,
              address,
            },
          })
        }
      }
      const subWallets = await db.subWallet.findMany({ where: { userId: user.id } })

      // Issue our JWT with unique ID for revocation
      const token = app.jwt.sign({
        sub: user.id,
        jti: crypto.randomUUID(),
        privyUserId: user.privyUserId,
        walletAddress: user.walletAddress,
      })

      // HttpOnly cookie — inaccessible to JS, mitigates XSS token theft.
      // SameSite=Lax so the JWT still rides along with same-origin XHR from
      // the Next.js frontend (same domain, different port via nginx).
      reply.setCookie('bags_jwt', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: TOKEN_TTL_SECONDS,
      })

      return {
        success: true,
        data: {
          user: {
            id: user.id,
            walletAddress: user.walletAddress,
            subWallets: subWallets.map((w) => ({ riskTier: w.riskTier, address: w.address })),
          },
        },
      }
    } catch (err) {
      app.log.error(err, 'Login failed')
      return reply.status(401).send({ error: 'Authentication failed' })
    }
  })

  /**
   * POST /auth/logout
   * Adds the current JWT to the Redis denylist so it can't be reused.
   */
  app.post('/logout', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const payload = await req.jwtVerify<{ jti?: string }>()
      if (payload.jti) {
        await redis.set(`${TOKEN_DENY_PREFIX}${payload.jti}`, '1', 'EX', TOKEN_TTL_SECONDS)
      }
      reply.clearCookie('bags_jwt', { path: '/' })
      return { success: true }
    } catch (err) {
      app.log.error(err, 'Logout failed')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /auth/me
   * Returns current user info.
   */
  app.get('/me', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const user = await db.user.findUnique({
        where: { id: req.authUser!.userId },
        include: { subWallets: true },
      })
      if (!user) return reply.status(404).send({ error: 'User not found' })

      const adminWallets = new Set(
        (process.env.ADMIN_WALLETS || '')
          .split(',')
          .map((w) => w.trim())
          .filter(Boolean),
      )
      const isAdmin = adminWallets.has(user.walletAddress)

      return {
        success: true,
        data: {
          id: user.id,
          walletAddress: user.walletAddress,
          isAdmin,
          subWallets: user.subWallets.map((w) => ({ riskTier: w.riskTier, address: w.address })),
          createdAt: user.createdAt,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get user')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}
