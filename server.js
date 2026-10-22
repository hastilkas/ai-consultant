// Локальный сервер для разработки: раздаёт public/ и те же обработчики /api/*,
// что работают на Vercel. Зависимостей нет, нужен только Node 22+.
//   npm run dev   →   http://localhost:3010
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chat from './api/chat.js';
import session from './api/session.js';
import catalog from './api/catalog.js';
import telegram from './api/telegram.js';
import { llmConfig } from './lib/llm.js';

const ROOT = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const PORT = Number(process.env.PORT) || 3010;
const ROUTES = { '/api/chat': chat, '/api/session': session, '/api/catalog': catalog, '/api/telegram': telegram };
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  let file = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

createServer((req, res) => {
  const route = ROUTES[new URL(req.url, 'http://localhost').pathname];
  if (route) return route(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => {
  const llm = llmConfig();
  console.log(`http://localhost:${PORT}  (${llm ? `модель ${llm.model} @ ${llm.baseUrl ?? 'GigaChat'}` : 'LLM_API_KEY не задан: чат не ответит'})`);
});
