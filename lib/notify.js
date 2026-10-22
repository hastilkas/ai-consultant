// Сообщения менеджеру в Telegram: новый заказ и просьба позвать человека.
// В каждом сообщении есть то, что бот узнал о клиенте, и хвост переписки,
// чтобы менеджер не переспрашивал.
import { SHOP, formatRub } from './catalog.js';
import { DELIVERY, PROFILE_TITLES, formatPhone } from './tools.js';

export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function profileLines(profile = {}) {
  const out = [];
  for (const [key, title] of Object.entries(PROFILE_TITLES)) {
    const v = profile[key];
    if (!v || (Array.isArray(v) && !v.length)) continue;
    const text = key === 'brew_methods' ? v.map((m) => SHOP.glossary[m] ?? m).join(', ') : Array.isArray(v) ? v.join('; ') : v;
    out.push(`${title}: ${text}`);
  }
  return out;
}

function dialogTail(session, n = 6) {
  return session.transcript
    .filter((t) => t.role === 'user' || t.role === 'bot')
    .slice(-n)
    .map((t) => {
      const text = t.text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      return `${t.role === 'user' ? '👤' : '🤖'} ${escapeHtml(text.length > 140 ? `${text.slice(0, 140)}…` : text)}`;
    });
}

function contextBlocks(session) {
  const blocks = [];
  const profile = profileLines(session.profile);
  if (profile.length) blocks.push(`<blockquote expandable>🧠 Что бот знает о клиенте\n${profile.map(escapeHtml).join('\n')}</blockquote>`);
  const tail = dialogTail(session);
  if (tail.length) blocks.push(`<blockquote expandable>💬 Конец переписки\n${tail.join('\n')}</blockquote>`);
  return blocks;
}

export function buildOrderMessage(order, session) {
  const d = DELIVERY[order.delivery];
  const lines = [
    `<b>🛒 Заказ № ${order.no}</b> · ИИ-консультант на сайте`,
    '#заказ',
    '',
    `👤 ${escapeHtml(order.name)}`,
    `📞 ${formatPhone(order.phone)}`,
    `🚚 ${d.title}${order.address ? `: ${escapeHtml(order.address)}` : ''}`,
  ];
  if (order.comment) lines.push(`📝 <i>${escapeHtml(order.comment)}</i>`);
  lines.push('');
  for (const l of order.lines) lines.push(`• ${escapeHtml(l.name)} × ${l.qty} — ${formatRub(l.sum)}`);
  const deliveryText = order.deliveryCost === 0 ? 'бесплатно' : `${formatRub(order.deliveryCost)}${d.approx ? ' (предв.)' : ''}`;
  lines.push(`Товары: ${formatRub(order.subtotal)} · доставка: ${deliveryText}`);
  lines.push(`<b>💰 Итого: ${formatRub(order.total)}</b>`);
  const blocks = contextBlocks(session);
  if (blocks.length) lines.push('', ...blocks);
  return lines.join('\n');
}

export function buildHandoffMessage({ reason, contact }, session) {
  const lines = [
    '<b>🙋 Клиент просит менеджера</b> · ИИ-консультант на сайте',
    '#менеджер',
    '',
    `❓ ${escapeHtml(reason)}`,
  ];
  if (contact) lines.push(`📞 ${escapeHtml(contact)}`);
  if (session.profile?.name) lines.push(`👤 ${escapeHtml(session.profile.name)}`);
  if (session.channel === 'telegram' && session.telegram) {
    const { username, chatId } = session.telegram;
    lines.push(username ? `💬 Написать: @${escapeHtml(username)}` : `💬 <a href="tg://user?id=${chatId}">Открыть чат с клиентом</a>`);
  }
  const blocks = contextBlocks(session);
  if (blocks.length) lines.push('', ...blocks);
  return lines.join('\n');
}

export function managerConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatIds = (env.MANAGER_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return token && chatIds.length ? { token, chatIds } : null;
}

export async function telegramCall(token, method, payload, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error(`Telegram ${method}: ${res.status} ${data.description ?? ''}`);
  return data;
}

// demo=true: текст уведомления возвращается ещё и в интерфейс, чтобы посетитель
// демо увидел, что получит владелец магазина.
export function createNotifier({ env = process.env, fetchImpl = fetch } = {}) {
  const tg = managerConfig(env);
  const demo = env.DEMO_MODE !== 'false';

  async function send(text) {
    if (tg) {
      await Promise.all(tg.chatIds.map((chat_id) => telegramCall(tg.token, 'sendMessage', {
        chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      }, fetchImpl).catch((err) => console.error('Telegram:', err.message))));
    } else {
      console.log(`[менеджеру] MANAGER_CHAT_IDS не задан, сообщение не отправлено:\n${text}\n`);
    }
    return demo ? text : null;
  }

  return {
    order: (order, session) => send(buildOrderMessage(order, session)),
    handoff: (info, session) => send(buildHandoffMessage(info, session)),
  };
}
