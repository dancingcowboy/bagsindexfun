import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { authRoutes } from './routes/auth.js'
import { depositRoutes } from './routes/deposits.js'
import { withdrawalRoutes } from './routes/withdrawals.js'
import { portfolioRoutes } from './routes/portfolio.js'
import { indexInfoRoutes } from './routes/index-info.js'
import { projectRoutes } from './routes/projects.js'
import { analysisRoutes } from './routes/analysis.js'
import { solanaRpcRoutes } from './routes/solana-rpc.js'
import { adminRoutes } from './routes/admin.js'
import { chatRoutes } from './routes/chat.js'
import { db } from '@bags-index/db'
import { redis } from './queue/redis.js'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
  // 8 MB — tweet image uploads come in as base64 data URLs through the
  // regular JSON PATCH /admin/tweets/:id endpoint.
  bodyLimit: 8 * 1024 * 1024,
  // Behind nginx — trust X-Forwarded-For so req.ip is the real client IP.
  // Without this, all requests share 127.0.0.1 and rate-limiting is global.
  trustProxy: true,
})

// ─── Plugins ─────────────────────────────────────────────────────────────────

await app.register(helmet, { contentSecurityPolicy: false })

await app.register(cors, {
  origin: process.env.WEB_URL || 'http://localhost:3000',
  credentials: true,
})

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set and at least 32 characters')
}

await app.register(cookie, {
  secret: jwtSecret, // sign cookies with the same 32+ char secret
  parseOptions: {},
})

await app.register(jwt, {
  secret: jwtSecret,
  sign: { expiresIn: '7d' },
  cookie: { cookieName: 'bags_jwt', signed: false },
})

await app.register(rateLimit, {
  global: true,
  max: 100,
  timeWindow: '1 minute',
  redis,
})

// ─── Error sanitization ──────────────────────────────────────────────────────

const IS_PROD = process.env.NODE_ENV === 'production'

const SAFE_ERROR_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable entity',
}

app.setErrorHandler((err: any, req, reply) => {
  if (err.validation) {
    return reply.status(400).send({ error: 'Validation error', details: err.validation })
  }
  if (err.statusCode === 429) {
    return reply.status(429).send({ error: 'Too many requests. Please slow down.' })
  }
  app.log.error({ err, url: req.url, method: req.method }, 'Unhandled error')
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500
  return reply.status(status).send({
    error: SAFE_ERROR_MESSAGES[status] || 'Internal server error',
  })
})

// ─── Audit log hook ──────────────────────────────────────────────────────────

app.addHook('onResponse', async (req, reply) => {
  if (req.method === 'GET' || reply.statusCode >= 400) return
  const user = req.authUser
  if (!user) return
  try {
    await db.auditLog.create({
      data: {
        userId: user.userId,
        action: `${req.method} ${req.routeOptions?.url || req.url}`,
        resource: 'api',
        ipAddress: req.ip,
      },
    })
  } catch { /* non-critical */ }
})

// ─── Routes ──────────────────────────────────────────────────────────────────

// Auth — rate limit login/logout (20 req/min per IP) to blunt credential
// stuffing. /auth/me is registered separately under the global limiter so
// read-only identity checks aren't blocked by login retry storms.
await app.register(async (scoped) => {
  await scoped.register(rateLimit, {
    max: 20,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (req) => req.ip,
  })
  await scoped.register(authRoutes, { prefix: '/auth' })
})

// Authenticated routes
await app.register(depositRoutes, { prefix: '/deposits' })
await app.register(withdrawalRoutes, { prefix: '/withdrawals' })
await app.register(portfolioRoutes, { prefix: '/portfolio' })

// Public routes
await app.register(indexInfoRoutes, { prefix: '/index' })
await app.register(projectRoutes, { prefix: '/projects' })
await app.register(analysisRoutes, { prefix: '/analysis' })
await app.register(solanaRpcRoutes, { prefix: '/solana/rpc' })

// Chat — webhook is unauthenticated (Telegram calls it) so rate-limit it
await app.register(async (scoped) => {
  await scoped.register(rateLimit, {
    max: 30,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (req) => req.ip,
  })
  await scoped.register(chatRoutes, { prefix: '/chat' })
})

// Admin routes
await app.register(adminRoutes, { prefix: '/admin' })

// Health check
app.get('/health', async () => ({
  status: 'ok',
  version: '0.1.0',
  timestamp: new Date().toISOString(),
}))

// ─── Graceful shutdown ───────────────────────────────────────────────────────

const gracefulShutdown = async () => {
  app.log.info('Shutting down...')
  await app.close()
  await redis.quit()
  process.exit(0)
}

process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

// ─── Start ───────────────────────────────────────────────────────────────────

try {
  const port = parseInt(process.env.PORT || '3001')
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`bags-index API running on port ${port}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
