 Done. The chat widget is now live on the dashboard. You'll need to set these env vars on the server for the Telegram integration to
  work:

  - TELEGRAM_BOT_TOKEN — create a bot via @BotFather (or reuse the existing one)
  - TELEGRAM_CHAT_ID — the group/chat where you want to receive support messages
  - TELEGRAM_WEBHOOK_SECRET — any random string for webhook validation

  Then set the webhook URL with Telegram:
  https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://bagsindex.fun/api/chat/webhook&secret_token=<YOUR_SECRET>

  When a beta tester sends a message from the dashboard, it appears in your Telegram. You reply using Telegram's "Reply" feature and it
  shows up back in their widget.
