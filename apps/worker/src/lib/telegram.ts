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

/**
 * Send a direct message to a specific user via the same bot.
 * Returns `{ blocked: true }` when the user blocked the bot / never /started
 * so callers can auto-disable notifications for that user.
 */
export async function postToUserTelegram(
  chatId: bigint,
  text: string,
): Promise<{ ok: boolean; blocked: boolean }> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { ok: false, blocked: false }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId.toString(),
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    if (res.ok) return { ok: true, blocked: false }
    const body = (await res.json().catch(() => ({}))) as { description?: string }
    const blocked =
      res.status === 403 ||
      /bot was blocked|user is deactivated|chat not found/i.test(body?.description ?? '')
    console.error('[telegram/dm] send failed', res.status, body)
    return { ok: false, blocked }
  } catch (err) {
    console.error('[telegram/dm] send error', err)
    return { ok: false, blocked: false }
  }
}
