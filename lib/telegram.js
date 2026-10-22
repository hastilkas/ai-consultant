// Тот же консультант в Telegram. Память общая с сайтом по устройству кода:
// агент, инструменты и лимиты одни и те же, отличается только «рисование» ответа.
import { handleMessage, openSession, loadSession, saveSession, ChatError } from './service.js';
import { newSession, startVisit, logEntry } from './agent.js';
import { getProduct, formatRub } from './catalog.js';
import { cartSummary, setCartQty } from './tools.js';
import { escapeHtml, telegramCall } from './notify.js';

const EMOJI = { beans: '☕', drip: '🫖', grinder: '⚙️', brewer: '🫗', kettle: '🫖', accessory: '🧰', machine: '🏭' };

// Ответ модели в простом markdown → HTML, который понимает Telegram.
export function toTelegramHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^\s*[-*] /gm, '• ');
}

export function productsMessage(ids) {
  const products = ids.map(getProduct).filter(Boolean);
  const text = products.map((p) => {
    const head = `${EMOJI[p.category] ?? '•'} <b>${escapeHtml(p.name)}</b> · ${formatRub(p.price)} за ${p.unit}`;
    const notes = p.notes?.length ? `${escapeHtml(p.notes.join(', '))} · ` : '';
    return `${head}\n${notes}${p.stock > 0 ? 'в наличии' : 'нет в наличии'}`;
  }).join('\n\n');
  const buttons = products.filter((p) => p.stock > 0).map((p) => [{ text: `🛒 ${p.name} — ${formatRub(p.price)}`, callback_data: `add:${p.id}` }]);
  return { text, reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined };
}

export function cartMessage(cart) {
  const sum = cartSummary(cart);
  if (!sum.lines.length) return 'Корзина пуста. Расскажите, чем варите кофе, и я подберу.';
  return [
    '<b>🛒 Корзина</b>',
    ...sum.lines.map((l) => `• ${escapeHtml(l.name)} × ${l.qty} — ${formatRub(l.sum)}`),
    `Сумма: <b>${formatRub(sum.subtotal)}</b>`,
    '',
    'Чтобы оформить, напишите «оформляем».',
  ].join('\n');
}

export const sessionIdFor = (chatId) => `telegram_${chatId}`;

export async function handleUpdate(update, { deps, token, fetchImpl = fetch }) {
  const tg = (method, payload) => telegramCall(token, method, payload, fetchImpl);
  const send = (chat_id, text, extra = {}) => tg('sendMessage', {
    chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra,
  });

  // Telegram повторяет вебхук, если ответ задержался; второй раз не обрабатываем.
  if (update.update_id != null && !(await deps.store.setNx(`tg:u:${update.update_id}`, 1, 3600))) return;

  if (update.callback_query) {
    const q = update.callback_query;
    const chatId = q.message?.chat?.id;
    const [action, id] = String(q.data ?? '').split(':');
    const p = getProduct(id);
    if (action !== 'add' || !p || !chatId) return tg('answerCallbackQuery', { callback_query_id: q.id });
    const session = await loadSession(deps.store, sessionIdFor(chatId));
    const current = session.cart.find((l) => l.id === p.id)?.qty ?? 0;
    if (current >= p.stock) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Больше на складе нет', show_alert: true });
    setCartQty(session, p.id, current + 1);
    const sum = cartSummary(session.cart);
    logEntry(session, { tool: 'ui', summary: `Клиент сам добавил в корзину: ${p.name} × ${current + 1}` });
    await saveSession(deps.store, session);
    return tg('answerCallbackQuery', { callback_query_id: q.id, text: `В корзине: ${p.name} × ${current + 1}. Сумма ${formatRub(sum.subtotal)}` });
  }

  const msg = update.message;
  if (!msg?.chat || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const sessionId = sessionIdFor(chatId);
  const text = msg.text?.trim();
  if (!text) return send(chatId, 'Я понимаю только текст. Напишите, какой кофе ищете 🙂');

  if (text === '/start' || text === '/new') {
    let session = await openSession({ sessionId, deps });
    if (text === '/new') {
      session = newSession(sessionId);
      startVisit(session);
      await saveSession(deps.store, session);
    }
    const last = session.transcript.filter((t) => t.role === 'bot').at(-1);
    return send(chatId, toTelegramHtml(last.text));
  }
  if (text === '/cart') {
    const session = await loadSession(deps.store, sessionId);
    return send(chatId, cartMessage(session.cart));
  }

  // Ответ собираем по порядку (текст, карточки, снова текст) и отправляем после
  // того, как агент закончил; пока он думает, клиент видит «печатает…».
  const parts = [];
  let buffer = '';
  const cut = () => {
    if (buffer.trim()) parts.push({ text: toTelegramHtml(buffer.trim()) });
    buffer = '';
  };
  const emit = (ev) => {
    if (ev.type === 'text') buffer += ev.delta;
    else if (ev.type === 'tool') tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    else if (ev.type === 'products') {
      cut();
      const m = productsMessage(ev.products.map((p) => p.id));
      parts.push({ text: m.text, extra: m.reply_markup ? { reply_markup: m.reply_markup } : {} });
    } else if (ev.type === 'owner') {
      cut();
      parts.push({ text: `<i>📨 Демо: так это сообщение увидит менеджер магазина</i>

${ev.text}` });
    } else if (ev.type === 'error') {
      cut();
      parts.push({ text: escapeHtml(ev.message) });
    }
  };

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    await handleMessage({
      sessionId,
      text,
      ip: `tg:${chatId}`,
      deps,
      emit,
      prepare: (session) => {
        session.channel = 'telegram';
        session.telegram = { chatId, username: msg.from?.username ?? null };
      },
    });
  } catch (err) {
    if (!(err instanceof ChatError)) throw err;
    parts.push({ text: escapeHtml(err.message) });
  }
  cut();
  for (const part of parts) await send(chatId, part.text, part.extra);
}
