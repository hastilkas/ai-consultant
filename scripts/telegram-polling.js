// Telegram-бот без вебхука, для локальной проверки: npm run telegram
// Забирает сообщения сам (long polling), вебхук на время работы снимается.
import { handleUpdate } from '../lib/telegram.js';
import { createDeps } from '../lib/service.js';
import { telegramCall } from '../lib/notify.js';
import { BOT_COMMANDS } from './set-webhook.js';

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error('Задайте TELEGRAM_BOT_TOKEN в .env');
  process.exit(1);
}
const deps = createDeps();
if (!deps.llm) console.warn('LLM_API_KEY не задан: бот будет отвечать, что не подключён к нейросети.');

await telegramCall(token, 'deleteWebhook', {});
await telegramCall(token, 'setMyCommands', { commands: BOT_COMMANDS });
const me = await telegramCall(token, 'getMe', {});
console.log(`@${me.result?.username} слушает сообщения. Ctrl+C, чтобы остановить.`);

let offset = 0;
for (;;) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`, { signal: AbortSignal.timeout(40000) });
    const data = await res.json();
    for (const update of data.result ?? []) {
      offset = update.update_id + 1;
      handleUpdate(update, { deps, token }).catch((err) => console.error(err));
    }
  } catch (err) {
    console.error('getUpdates:', err.message);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
