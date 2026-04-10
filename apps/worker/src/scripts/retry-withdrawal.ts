/**
 * One-shot: re-enqueue a PARTIAL withdrawal for retry.
 * Usage: npx tsx src/scripts/retry-withdrawal.ts <withdrawalId>
 */
import { db } from '@bags-index/db'
import { Queue } from 'bullmq'
import { QUEUE_WITHDRAWAL } from '@bags-index/shared'
import { redis } from '../queue/redis.js'

const withdrawalId = process.argv[2]
if (!withdrawalId) {
  console.error('Usage: npx tsx src/scripts/retry-withdrawal.ts <withdrawalId>')
  process.exit(1)
}

async function main() {
  const withdrawal = await db.withdrawal.findUnique({ where: { id: withdrawalId } })
  if (!withdrawal) { console.error('Not found'); process.exit(1) }
  console.log(`Withdrawal ${withdrawalId}: status=${withdrawal.status} riskTier=${withdrawal.riskTier}`)

  if (withdrawal.status !== 'PARTIAL') {
    console.error(`Status is ${withdrawal.status}, expected PARTIAL`)
    process.exit(1)
  }

  const subWallet = await db.subWallet.findUnique({
    where: { userId_riskTier: { userId: withdrawal.userId, riskTier: withdrawal.riskTier } },
    include: { holdings: true },
  })
  if (!subWallet) { console.error('Sub-wallet not found'); process.exit(1) }
  console.log(`Sub-wallet: ${subWallet.address} (${subWallet.holdings.length} holdings)`)

  await db.withdrawal.update({ where: { id: withdrawalId }, data: { status: 'PENDING' } })

  const queue = new Queue(QUEUE_WITHDRAWAL, { connection: redis })
  await queue.add('liquidate', {
    withdrawalId,
    userId: withdrawal.userId,
    subWalletId: subWallet.id,
    pct: 100,
  })
  console.log('Enqueued. Worker will pick it up shortly.')
  await queue.close()
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
