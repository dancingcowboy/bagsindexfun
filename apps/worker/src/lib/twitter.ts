import { TwitterApi } from 'twitter-api-v2'

/**
 * Twitter (X) client for the bags-index launch campaign.
 *
 * Posts via @bagsIndexSol using the OAuth 1.0a credentials shared with
 * tax-ai. The Twitter app must be linked to @bagsIndexSol via the
 * "App permissions" + "User authentication settings" flow in the dev
 * portal — same dev portal app, regenerated access token under the
 * @bagsIndexSol account.
 */

let cached: TwitterApi | null = null

function client(): TwitterApi {
  if (cached) return cached
  const appKey = process.env.TWITTER_API_KEY
  const appSecret = process.env.TWITTER_API_SECRET
  const accessToken = process.env.TWITTER_ACCESS_TOKEN
  const accessSecret = process.env.TWITTER_ACCESS_SECRET
  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    throw new Error('TWITTER_API_KEY/SECRET/ACCESS_TOKEN/ACCESS_SECRET must be set')
  }
  cached = new TwitterApi({ appKey, appSecret, accessToken, accessSecret })
  return cached
}

/**
 * Post a tweet, optionally with an image fetched from a URL.
 * Returns the new tweet ID.
 */
export async function postTweet(text: string, imageUrl?: string | null): Promise<string> {
  const c = client()

  if (imageUrl) {
    // Fetch the image into a buffer
    const res = await fetch(imageUrl)
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') || 'image/jpeg'
    const mimeType = contentType.split(';')[0].trim()

    const mediaId = await c.v1.uploadMedia(buffer, { mimeType })
    const result = await c.v2.tweet({
      text,
      media: { media_ids: [mediaId] },
    })
    return result.data.id
  }

  const result = await c.v2.tweet(text)
  return result.data.id
}
