// POST /api/telegram — вебхук Telegram-бота. Подключение: npm run webhook -- https://ваш-сайт.vercel.app
import { handleUpdate } from '../lib/telegram.js';
import { createDeps } from '../lib/service.js';
import { readJson, sendJson } from '../lib/http.js';

let deps;

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  // Секрет в заголовке ставит сам Telegram: без него кто угодно мог бы слать боту «апдейты».
  if (!token || !secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return sendJson(res, 403, { ok: false });
  deps ??= createDeps();
  try {
    await handleUpdate(await readJson(req), { deps, token });
  } catch (err) {
    console.error('telegram update failed:', err);
  }
  // Всегда 200: иначе Telegram будет повторять тот же апдейт.
  return sendJson(res, 200, { ok: true });
}
