/**
 * Unsplash client for prefilling tweet images.
 * Uses the same UNSPLASH_ACCESS_KEY shared with tax-ai.
 */

const API = 'https://api.unsplash.com'

export interface UnsplashPhoto {
  id: string
  urls: { regular: string; small: string; raw: string }
  alt_description: string | null
  user: { name: string; links: { html: string } }
}

export async function searchUnsplash(query: string, perPage = 6): Promise<UnsplashPhoto[]> {
  const key = process.env.UNSPLASH_ACCESS_KEY
  if (!key) throw new Error('UNSPLASH_ACCESS_KEY not set')

  const url = `${API}/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`
  const res = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } })
  if (!res.ok) throw new Error(`Unsplash API error: ${res.status}`)
  const data = (await res.json()) as { results: UnsplashPhoto[] }
  return data.results
}

/** Pick a random photo for a query — used for bulk prefill. */
export async function pickRandomPhoto(query: string): Promise<UnsplashPhoto | null> {
  const photos = await searchUnsplash(query, 10)
  if (photos.length === 0) return null
  return photos[Math.floor(Math.random() * photos.length)]
}
