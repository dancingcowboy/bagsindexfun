import type { FastifyRequest, FastifyReply } from 'fastify'
import { PrivyClient } from '@privy-io/server-auth'
import { redis } from '../queue/redis.js'

let privyClient: PrivyClient | null = null

function getPrivy(): PrivyClient {
  if (!privyClient) {
    const appId = process.env.PRIVY_APP_ID
    const appSecret = process.env.PRIVY_APP_SECRET
    if (!appId || !appSecret) throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET are required')
    privyClient = new PrivyClient(appId, appSecret)
  }
  return privyClient
}

export interface AuthUser {
  userId: string
  privyUserId: string
  walletAddress: string
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser
  }
}

/**
 * Auth middleware — verifies JWT from our API (issued at login).
 * Attaches authUser to request.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    // @fastify/jwt auto-reads from the `bags_jwt` cookie (configured in
    // server.ts) before falling back to the Authorization header.
    const payload = await req.jwtVerify<{
      sub: string
      jti?: string
      privyUserId: string
      walletAddress: string
    }>()

    // Check Redis denylist for revoked tokens
    if (payload.jti) {
      const denied = await redis.get(`jwt:deny:${payload.jti}`)
      if (denied) {
        return reply.status(401).send({ error: 'Unauthorized' })
      }
    }

    req.authUser = {
      userId: payload.sub,
      privyUserId: payload.privyUserId,
      walletAddress: payload.walletAddress,
    }
  } catch {
    return reply.status(401).send({ error: 'Unauthorized' })
  }
}

/**
 * Admin middleware — checks wallet is in ADMIN_WALLETS whitelist.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply)
  if (reply.sent) return

  const adminWallets = (process.env.ADMIN_WALLETS || '').split(',').filter(Boolean)
  if (!req.authUser || !adminWallets.includes(req.authUser.walletAddress)) {
    return reply.status(403).send({ error: 'Forbidden' })
  }
}

/**
 * Verify a Privy auth token (used during login flow).
 * Returns the Privy user.
 */
export async function verifyPrivyToken(authToken: string) {
  const privy = getPrivy()
  return privy.verifyAuthToken(authToken)
}

export { getPrivy }
