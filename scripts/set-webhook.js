// Подключает вебхук Telegram к развёрнутому сайту: npm run webhook -- https://ваш-сайт.vercel.app
import { pathToFileURL } from 'node:url';
import { telegramCall } from '../lib/notify.js';

export const BOT_COMMANDS = [
  { command: 'cart', description: 'Корзина' },
  { command: 'new', description: 'Начать заново (бот всё забудет)' },
];

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const site = process.argv[2]?.replace(/\/$/, '');
  if (!token || !secret || !site) {
    console.error('Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET в .env и адрес сайта аргументом.');
    process.exit(1);
  }
  const r = await telegramCall(token, 'setWebhook', {
    url: `${site}/api/telegram`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  await telegramCall(token, 'setMyCommands', { commands: BOT_COMMANDS });
  console.log(r.ok ? `Вебхук подключён: ${site}/api/telegram` : `Ошибка: ${r.description}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
