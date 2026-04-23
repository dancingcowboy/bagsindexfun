const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''

type InlineButton = { text: string; callback_data?: string; url?: string }
export type InlineKeyboard = { inline_keyboard: InlineButton[][] }

async function tg(method: string, body: Record<string, unknown>) {
  if (!TOKEN) return { ok: false }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { ok: boolean; result?: any; description?: string }
}

export async function sendMessage(
  chatId: string | bigint,
  text: string,
  replyMarkup?: InlineKeyboard,
) {
  return tg('sendMessage', {
    chat_id: chatId.toString(),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  })
}

export async function editMessageText(
  chatId: string | bigint,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboard,
) {
  return tg('editMessageText', {
    chat_id: chatId.toString(),
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  })
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert?: boolean,
) {
  return tg('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    ...(showAlert ? { show_alert: true } : {}),
  })
}
