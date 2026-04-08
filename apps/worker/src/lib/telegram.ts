/**
 * Minimal Telegram Bot API client. Mirrors X posts into the configured chat.
 * No-op when env vars are missing (local dev).
 */
export async function postToTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error('[telegram] send failed', res.status, body)
    }
  } catch (err) {
    console.error('[telegram] send error', err)
  }
}

/** Mirror an X post into Telegram with the tweet URL. */
export async function mirrorTweetToTelegram(text: string, twitterId: string, handle = 'bagsIndexSol') {
  const url = `https://x.com/${handle}/status/${twitterId}`
  await postToTelegram(`${text}\n\n🔗 ${url}`)
}
