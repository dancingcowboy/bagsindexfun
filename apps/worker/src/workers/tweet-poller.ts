import { db } from '@bags-index/db'
import { postTweet } from '../lib/twitter.js'
import { mirrorTweetToTelegram } from '../lib/telegram.js'

/**
 * Tweet poller — checks every 60s for ACTIVE tweets whose scheduledAt has
 * passed and posts them to X via twitter-api-v2.
 *
 * Enforces a 50-minute minimum gap between any two tweets to avoid double-
 * posting on a clock skew or a manual retrigger.
 */

const POLL_MS = 60_000
const MIN_GAP_MS = 50 * 60 * 1000

let stopped = false
let timer: NodeJS.Timeout | null = null

async function tick() {
  // Skip if Twitter creds aren't configured (e.g. local dev)
  if (!process.env.TWITTER_API_KEY) return

  // Check the most recent SENT tweet — enforce minimum gap
  const lastSent = await db.tweet.findFirst({
    where: { status: 'SENT', sentAt: { not: null } },
    orderBy: { sentAt: 'desc' },
  })
  if (lastSent?.sentAt && Date.now() - lastSent.sentAt.getTime() < MIN_GAP_MS) {
    return
  }

  // Find the oldest due tweet
  const tweet = await db.tweet.findFirst({
    where: {
      status: 'ACTIVE',
      scheduledAt: { lte: new Date() },
    },
    orderBy: { scheduledAt: 'asc' },
  })
  if (!tweet) return

  console.log(`[tweet-poller] posting ${tweet.id}: ${tweet.text.slice(0, 60)}…`)

  try {
    const twitterId = await postTweet(tweet.text, tweet.imageUrl)
    await db.tweet.update({
      where: { id: tweet.id },
      data: {
        status: 'SENT',
        twitterId,
        sentAt: new Date(),
        errorMessage: null,
      },
    })
    console.log(`[tweet-poller] posted ${tweet.id} → twitterId=${twitterId}`)
    await mirrorTweetToTelegram(tweet.text, twitterId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[tweet-poller] failed ${tweet.id}: ${msg}`)
    await db.tweet.update({
      where: { id: tweet.id },
      data: { status: 'FAILED', errorMessage: msg },
    })
  }
}

export function startTweetPoller() {
  console.log('[tweet-poller] starting (poll every 60s, min gap 50min)')
  const loop = async () => {
    if (stopped) return
    try {
      await tick()
    } catch (err) {
      console.error('[tweet-poller] tick error:', err)
    }
    timer = setTimeout(loop, POLL_MS)
  }
  loop()
}

export function stopTweetPoller() {
  stopped = true
  if (timer) clearTimeout(timer)
}
