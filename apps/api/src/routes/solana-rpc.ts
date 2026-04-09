import type { FastifyInstance } from 'fastify'

/**
 * Thin JSON-RPC proxy to our server-side Solana RPC (Helius).
 *
 * The browser needs a working RPC to build deposit transfers
 * (getLatestBlockhash + confirmTransaction) but the public
 * api.mainnet-beta endpoint blocks browsers with 403, and we don't
 * want to leak HELIUS_API_KEY to the client.
 *
 * Unauthenticated on purpose (deposit flow runs pre-persist), but
 * locked down to a small whitelist of read-only methods the deposit
 * UI actually needs, and covered by the global IP rate limiter
 * registered in server.ts.
 */
const ALLOWED_METHODS = new Set([
  'getLatestBlockhash',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getTransaction',
  'getBlockHeight',
])

export async function solanaRpcRoutes(app: FastifyInstance) {
  app.post('/', async (req, reply) => {
    const upstream = process.env.HELIUS_RPC_URL
    if (!upstream) {
      return reply.status(500).send({ error: 'RPC not configured' })
    }
    const body = req.body as any
    const method = body?.method
    if (!method || !ALLOWED_METHODS.has(method)) {
      return reply.status(400).send({ error: 'Method not allowed' })
    }
    try {
      const res = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      reply.status(res.status).header('content-type', 'application/json').send(text)
    } catch (err) {
      app.log.error(err, 'Solana RPC proxy failed')
      return reply.status(502).send({ error: 'RPC upstream error' })
    }
  })
}
