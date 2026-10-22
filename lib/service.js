// Общая обвязка для всех каналов: загрузка и сохранение диалога, лимиты, замок
// от параллельных запросов и обработка ошибок модели.
import { newSession, startVisit, runTurn, compact } from './agent.js';
import { createLlm, llmConfig } from './llm.js';
import { createGigaChat } from './gigachat.js';
import { createNotifier } from './notify.js';
import { getStore } from './store.js';

const SESSION_TTL = 60 * 60 * 24 * 90; // память о клиенте живёт 90 дней с последнего визита
export const MAX_MESSAGE = 800;

export class ChatError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const validSessionId = (id) => typeof id === 'string' && /^[A-Za-z0-9:_-]{8,80}$/.test(id);

export async function loadSession(store, id, now = Date.now()) {
  return (await store.get(`s:${id}`)) ?? newSession(id, now);
}

export async function saveSession(store, session) {
  await store.set(`s:${session.id}`, compact(session), SESSION_TTL);
}

// Защита кошелька: каждое сообщение стоит денег у провайдера модели.
export async function checkLimits(store, { ip, sessionId, env = process.env, now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const limits = [
    [`rl:ip:${ip || 'unknown'}`, 600, Number(env.LIMIT_PER_IP_10MIN ?? 40), 'Слишком много сообщений подряд. Передохните пару минут и продолжим.'],
    [`rl:s:${sessionId}:${day}`, 86400, Number(env.LIMIT_PER_SESSION_DAY ?? 120), 'На сегодня лимит сообщений в демо исчерпан. Приходите завтра!'],
    [`rl:all:${day}`, 86400, Number(env.LIMIT_TOTAL_DAY ?? 3000), 'Демо сегодня очень популярно, дневной лимит исчерпан. Загляните завтра.'],
  ];
  for (const [key, ttl, max, message] of limits) {
    if ((await store.incr(key, ttl)) > max) throw new ChatError(message, 429);
  }
}

export function createDeps({ env = process.env, fetchImpl = fetch } = {}) {
  const config = llmConfig(env);
  return {
    store: getStore(env),
    llm: !config ? null : config.provider === 'gigachat' ? createGigaChat(config, { fetchImpl }) : createLlm(config, { fetchImpl }),
    notify: createNotifier({ env, fetchImpl }),
    env,
  };
}

export async function openSession({ sessionId, deps, now = Date.now() }) {
  if (!validSessionId(sessionId)) throw new ChatError('Некорректный идентификатор диалога.');
  const session = await loadSession(deps.store, sessionId, now);
  if (startVisit(session, now)) await saveSession(deps.store, session);
  return session;
}

// Одно сообщение клиента. Ошибки отдаются через emit, чтобы чат показал их
// обычной репликой, а не молча завис.
export async function handleMessage({ sessionId, text, ip = '', deps, emit, now = Date.now(), prepare }) {
  const message = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!validSessionId(sessionId)) throw new ChatError('Некорректный идентификатор диалога.');
  if (!message) throw new ChatError('Пустое сообщение.');
  if (message.length > MAX_MESSAGE) throw new ChatError(`Слишком длинное сообщение: до ${MAX_MESSAGE} символов.`);
  if (!deps.llm) throw new ChatError('Консультант пока не подключён к нейросети: не задан ключ API.', 503);

  const { store } = deps;
  await checkLimits(store, { ip, sessionId, env: deps.env, now });
  if (!(await store.setNx(`lock:${sessionId}`, 1, 90))) throw new ChatError('Подождите, предыдущий ответ ещё пишется.', 409);

  try {
    const session = await loadSession(store, sessionId, now);
    prepare?.(session);
    startVisit(session, now);
    const before = structuredClone(session);
    try {
      await runTurn({ session, text: message, llm: deps.llm, notify: deps.notify, emit, now });
    } catch (err) {
      console.error('turn failed:', err);
      // Откатываем память к состоянию до сообщения, чтобы не оставить в истории
      // оборванный вызов инструмента. Клиент увидит своё сообщение и извинение.
      const apology = 'Не получилось ответить: сервис нейросети сейчас не отвечает. Попробуйте отправить сообщение ещё раз через минуту.';
      Object.assign(session, before);
      session.transcript.push({ role: 'user', text: message }, { role: 'error', text: apology });
      emit({ type: 'error', message: apology });
    }
    await saveSession(store, session);
    return session;
  } finally {
    await store.del(`lock:${sessionId}`);
  }
}
