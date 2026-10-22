// POST /api/chat — сообщение клиента. Ответ идёт потоком (Server-Sent Events):
// текст печатается по мере генерации, карточки и корзина приходят отдельными событиями.
import { handleMessage, createDeps, ChatError } from '../lib/service.js';
import { readJson, sendJson, clientIp } from '../lib/http.js';

let deps;

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  deps ??= createDeps();

  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: 'Некорректный запрос.' });
  }

  let started = false;
  const emit = (event) => {
    if (!started) {
      started = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await handleMessage({ sessionId: body.sessionId, text: body.message, ip: clientIp(req), deps, emit });
    emit({ type: 'done' });
    res.end();
  } catch (err) {
    if (!(err instanceof ChatError)) console.error(err);
    const status = err instanceof ChatError ? err.status : 500;
    const message = err instanceof ChatError ? err.message : 'Что-то сломалось на сервере. Попробуйте ещё раз.';
    if (started) {
      emit({ type: 'error', message });
      res.end();
    } else {
      sendJson(res, status, { error: message });
    }
  }
}
