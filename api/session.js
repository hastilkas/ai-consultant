// GET  /api/session?id=…  — открыть чат: история, память, корзина.
// POST /api/session        — действия без нейросети: кнопка «В корзину»,
//                            «Забыть меня» и «Вернуться через неделю» для демо.
import { openSession, createDeps, loadSession, saveSession, validSessionId } from '../lib/service.js';
import { newSession, publicState, startVisit, logEntry } from '../lib/agent.js';
import { getProduct, formatRub } from '../lib/catalog.js';
import { setCartQty, cartSummary } from '../lib/tools.js';
import { readJson, sendJson, queryParam } from '../lib/http.js';

let deps;
const WEEK = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  deps ??= createDeps();
  try {
    if (req.method === 'GET') {
      const session = await openSession({ sessionId: queryParam(req, 'id'), deps });
      return sendJson(res, 200, { ...publicState(session), ai: Boolean(deps.llm) });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });

    const body = await readJson(req);
    if (!validSessionId(body.sessionId)) return sendJson(res, 400, { error: 'Некорректный идентификатор диалога.' });
    let session = await loadSession(deps.store, body.sessionId);

    if (body.action === 'cart') {
      const p = getProduct(body.productId);
      if (!p) return sendJson(res, 400, { error: 'Нет такого товара.' });
      const current = session.cart.find((l) => l.id === p.id)?.qty ?? 0;
      const want = Math.round(Number(body.qty ?? current + 1)) || 0;
      if (want > current && p.stock <= 0) return sendJson(res, 409, { error: 'Этого товара сейчас нет в наличии.' });
      const qty = Math.max(0, Math.min(p.stock, 20, want));
      setCartQty(session, p.id, qty);
      const sum = cartSummary(session.cart);
      logEntry(session, { tool: 'ui', summary: `Клиент сам ${qty > current ? 'добавил' : 'изменил'} в корзине: ${p.name} × ${qty}. Сумма ${formatRub(sum.subtotal)}` });
    } else if (body.action === 'reset') {
      session = newSession(session.id);
      startVisit(session);
    } else if (body.action === 'revisit') {
      // Демо памяти: сдвигаем «прошлое» на неделю назад и открываем новый визит.
      session.lastSeen -= WEEK;
      for (const o of session.orders) o.at -= WEEK;
      startVisit(session);
    } else {
      return sendJson(res, 400, { error: 'Неизвестное действие.' });
    }

    await saveSession(deps.store, session);
    return sendJson(res, 200, { ...publicState(session), ai: Boolean(deps.llm) });
  } catch (err) {
    console.error(err);
    return sendJson(res, err.status ?? 500, { error: err.status ? err.message : 'Ошибка сервера.' });
  }
}
