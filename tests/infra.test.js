import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStream, llmConfig, createLlm } from '../lib/llm.js';
import { MemoryStore, UpstashStore } from '../lib/store.js';
import { checkLimits, handleMessage, ChatError, validSessionId } from '../lib/service.js';
import { buildOrderMessage, buildHandoffMessage, createNotifier } from '../lib/notify.js';
import { toTelegramHtml, productsMessage, handleUpdate } from '../lib/telegram.js';
import { newSession } from '../lib/agent.js';
import { byteStream, scriptedLlm, fakeNotifier } from './helpers.js';

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test('поток: текст по кусочкам, аргументы инструмента склеиваются, разрыв посреди строки не страшен', async () => {
  const raw = [
    sse({ choices: [{ delta: { content: 'При' } }] }),
    sse({ choices: [{ delta: { content: 'вет' } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_products', arguments: '{"que' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"кения"}' } }] }, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ].join('');
  const parts = [];
  const out = await parseStream(byteStream([raw.slice(0, 50), raw.slice(50, 51), raw.slice(51)]), (d) => parts.push(d));
  assert.equal(out.content, 'Привет');
  assert.deepEqual(parts, ['При', 'вет']);
  assert.equal(out.toolCalls[0].function.name, 'search_products');
  assert.deepEqual(JSON.parse(out.toolCalls[0].function.arguments), { query: 'кения' });
  assert.equal(out.finishReason, 'tool_calls');
});

test('ошибка провайдера и HTTP-ошибка превращаются в LlmError', async () => {
  await assert.rejects(parseStream(byteStream([sse({ error: { message: 'quota' } })])), /quota/);
  const llm = createLlm({ baseUrl: 'https://x', model: 'm', apiKey: 'k' }, { fetchImpl: async () => new Response('bad key', { status: 401 }) });
  await assert.rejects(llm({ messages: [] }), /401/);
});

test('запрос к модели: ключ в заголовке, инструменты и поток включены', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response(byteStream([sse({ choices: [{ delta: { content: 'ok' } }] })]));
  };
  const llm = createLlm(llmConfig({ LLM_API_KEY: 'sk-1', LLM_MODEL: 'deepseek-chat' }), { fetchImpl });
  const out = await llm({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(out.content, 'ok');
  assert.equal(sent.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(sent.init.headers.Authorization, 'Bearer sk-1');
  assert.equal(sent.body.stream, true);
});

test('без ключа облачная модель не включается, локальная включается', () => {
  assert.equal(llmConfig({}), null);
  assert.ok(llmConfig({ LLM_BASE_URL: 'http://localhost:1234/v1', LLM_MODEL: 'qwen' }));
});

test('MemoryStore: TTL, setNx, incr', async () => {
  let now = 0;
  const s = new MemoryStore(() => now);
  await s.set('a', { x: 1 }, 10);
  assert.deepEqual(await s.get('a'), { x: 1 });
  now = 11000;
  assert.equal(await s.get('a'), null);
  assert.equal(await s.setNx('l', 1, 5), true);
  assert.equal(await s.setNx('l', 1, 5), false);
  assert.equal(await s.incr('c', 5), 1);
  assert.equal(await s.incr('c', 5), 2);
});

test('UpstashStore шлёт команды Redis в REST', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    const result = url.endsWith('/pipeline') ? [{ result: 3 }, { result: 1 }] : { result: JSON.stringify({ a: 1 }) };
    return new Response(JSON.stringify(result));
  };
  const s = new UpstashStore({ url: 'https://u.io/', token: 't', fetchImpl });
  assert.deepEqual(await s.get('k'), { a: 1 });
  await s.set('k', { a: 1 }, 60);
  assert.equal(await s.incr('n', 60), 3);
  assert.deepEqual(calls[1], ['https://u.io', ['SET', 'k', '{"a":1}', 'EX', 60]]);
  assert.deepEqual(calls[2][1][0], ['INCR', 'n']);
});

test('лимиты: после порога сообщения отклоняются с 429', async () => {
  const store = new MemoryStore();
  const env = { LIMIT_PER_IP_10MIN: 2 };
  await checkLimits(store, { ip: '1.1.1.1', sessionId: 'a', env });
  await checkLimits(store, { ip: '1.1.1.1', sessionId: 'a', env });
  await assert.rejects(checkLimits(store, { ip: '1.1.1.1', sessionId: 'a', env }), (e) => e instanceof ChatError && e.status === 429);
  await checkLimits(store, { ip: '2.2.2.2', sessionId: 'b', env });
});

test('валидация сообщения: пустое, длинное, кривой id, второй запрос параллельно', async () => {
  const store = new MemoryStore();
  const deps = { store, llm: scriptedLlm([]), notify: fakeNotifier(), env: {} };
  const id = 'valid-session-00001';
  await assert.rejects(handleMessage({ sessionId: id, text: '   ', deps }), /Пустое/);
  await assert.rejects(handleMessage({ sessionId: id, text: 'x'.repeat(801), deps }), /длинное/);
  await assert.rejects(handleMessage({ sessionId: '../etc', text: 'привет', deps }), /идентификатор/);
  await store.setNx(`lock:${id}`, 1, 90);
  await assert.rejects(handleMessage({ sessionId: id, text: 'привет', deps }), (e) => e.status === 409);
  assert.equal(validSessionId('telegram_123456789'), true);
});

test('без ключа нейросети чат честно говорит, что не подключён', async () => {
  const deps = { store: new MemoryStore(), llm: null, notify: fakeNotifier(), env: {} };
  await assert.rejects(handleMessage({ sessionId: 'valid-session-00002', text: 'привет', deps }), (e) => e.status === 503);
});

const order = {
  no: '4821', name: 'Илья <script>', phone: '79161234567', delivery: 'courier', address: 'Тверская 1', comment: 'смолоть под турку',
  lines: [{ name: 'Бразилия Сантос', qty: 2, sum: 1180 }], subtotal: 1180, deliveryCost: 350, total: 1530,
};

test('заказ менеджеру: экранирование, сумма, память и хвост переписки', () => {
  const session = newSession('x'.repeat(16));
  session.profile = { name: 'Илья', taste: 'без <кислинки>' };
  session.transcript = [{ role: 'user', text: 'хочу кофе для турки' }, { role: 'bot', text: 'Берите Бразилию' }];
  const text = buildOrderMessage(order, session);
  assert.match(text, /Заказ № 4821/);
  assert.match(text, /Илья &lt;script&gt;/);
  assert.match(text, /Итого: 1 530 ₽/);
  assert.match(text, /вкус: без &lt;кислинки&gt;/);
  assert.match(text, /👤 хочу кофе для турки/);
});

test('вызов менеджера из Telegram содержит ссылку на клиента', () => {
  const session = newSession('x'.repeat(16));
  session.channel = 'telegram';
  session.telegram = { chatId: 42, username: 'ilya' };
  assert.match(buildHandoffMessage({ reason: 'опт 10 кг' }, session), /@ilya/);
});

test('уведомление уходит во все чаты менеджеров, в демо копия возвращается', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body).chat_id);
    return new Response(JSON.stringify({ ok: true }));
  };
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: 't', MANAGER_CHAT_IDS: '1, -100', DEMO_MODE: 'true' }, fetchImpl });
  const copy = await n.order(order, newSession('x'.repeat(16)));
  assert.deepEqual(sent, ['1', '-100']);
  assert.match(copy, /Заказ № 4821/);
  const quiet = createNotifier({ env: { DEMO_MODE: 'false' }, fetchImpl });
  assert.equal(await quiet.order(order, newSession('x'.repeat(16))), null);
});

test('Telegram: markdown в HTML, карточки с кнопками только для товаров в наличии', () => {
  assert.equal(toTelegramHtml('**Бразилия** <3\n- раз'), '<b>Бразилия</b> &lt;3\n• раз');
  const m = productsMessage(['brazil-santos', 'guatemala-antigua']);
  assert.match(m.text, /Бразилия Сантос/);
  assert.equal(m.reply_markup.inline_keyboard.length, 1);
  assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, 'add:brazil-santos');
});

test('Telegram: сообщение проходит через агента, повтор апдейта игнорируется', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url.split('/').pop(), JSON.parse(init.body)]);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  const deps = {
    store: new MemoryStore(),
    llm: scriptedLlm([{ tools: [['show_products', { ids: ['brazil-santos'] }]] }, { text: 'Вот **отличный** вариант' }]),
    notify: fakeNotifier(),
    env: {},
  };
  const update = { update_id: 7, message: { chat: { id: 42, type: 'private' }, from: { username: 'ilya' }, text: 'кофе для турки' } };
  await handleUpdate(update, { deps, token: 't', fetchImpl });
  await handleUpdate(update, { deps, token: 't', fetchImpl });
  const messages = calls.filter(([m]) => m === 'sendMessage').map(([, b]) => b.text);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /Бразилия Сантос/);
  assert.equal(messages[1], 'Вот <b>отличный</b> вариант');
  const saved = await deps.store.get('s:telegram_42');
  assert.equal(saved.telegram.username, 'ilya');

  await handleUpdate({ update_id: 8, callback_query: { id: 'q', data: 'add:brazil-santos', message: { chat: { id: 42 } } } }, { deps, token: 't', fetchImpl });
  assert.deepEqual((await deps.store.get('s:telegram_42')).cart, [{ id: 'brazil-santos', qty: 1 }]);
});
