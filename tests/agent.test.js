import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSession, runTurn, startVisit, greeting, trimHistory, systemPrompt } from '../lib/agent.js';
import { scriptedLlm, fakeNotifier } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

function fresh() {
  const s = newSession('agent-session-0001', 0);
  startVisit(s, 0);
  return s;
}

test('полный цикл: поиск → карточки → текст, всё попадает в историю', async () => {
  const session = fresh();
  const llm = scriptedLlm([
    { tools: [['remember', { brew_methods: ['turka'], taste: 'без кислинки' }], ['search_products', { brew_method: 'turka', category: 'beans' }]] },
    { tools: [['show_products', { ids: ['brazil-santos', 'sumatra-mandheling'] }]] },
    { text: 'Для турки без кислинки берите **Бразилию**: шоколад и орех.' },
  ]);
  const events = [];
  await runTurn({ session, text: 'Варю в турке, не люблю кислый', llm, notify: fakeNotifier(), emit: (e) => events.push(e), now: 1000 });

  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.name), ['remember', 'search_products', 'show_products']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Для турки без кислинки берите **Бразилию**: шоколад и орех.');
  assert.deepEqual(session.transcript.map((t) => t.role), ['bot', 'user', 'products', 'bot']);
  assert.deepEqual(session.profile.brew_methods, ['turka']);
  // На каждый вызов инструмента в истории есть ответ с тем же id
  const callIds = session.history.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
  const resultIds = session.history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(callIds, resultIds);
  assert.equal(session.log.length, 3);
});

test('память о клиенте попадает в системный промпт', async () => {
  const session = fresh();
  session.profile = { name: 'Илья', brew_methods: ['moka'], taste: 'шоколад' };
  session.cart = [{ id: 'brazil-santos', qty: 2 }];
  const prompt = systemPrompt(session, 0);
  assert.match(prompt, /имя: Илья/);
  assert.match(prompt, /гейзерная кофеварка/);
  assert.match(prompt, /Бразилия Сантос \(id brazil-santos\) × 2 = 1 180 ₽/);
});

test('ошибка модели не оставляет в истории оборванных вызовов', async () => {
  const { handleMessage } = await import('../lib/service.js');
  const { MemoryStore } = await import('../lib/store.js');
  const store = new MemoryStore();
  const llm = scriptedLlm([{ tools: [['search_products', { query: 'кения' }]] }, { error: 'timeout' }]);
  const events = [];
  const deps = { store, llm, notify: fakeNotifier(), env: {} };
  const session = await handleMessage({ sessionId: 'svc-session-00001', text: 'есть Кения?', deps, emit: (e) => events.push(e) });
  assert.ok(events.some((e) => e.type === 'error'));
  assert.ok(!session.history.some((m) => m.tool_calls));
  assert.deepEqual(session.transcript.slice(-2).map((t) => t.role), ['user', 'error']);
  assert.equal(await store.get('lock:svc-session-00001'), null);
});

test('модель, которая бесконечно зовёт инструменты, получает запасной ответ', async () => {
  const session = fresh();
  const llm = scriptedLlm(Array.from({ length: 12 }, () => ({ tools: [['search_products', {}]] })));
  await runTurn({ session, text: 'привет', llm, notify: fakeNotifier() });
  assert.match(session.transcript.at(-1).text, /запуталась/);
  assert.equal(llm.calls.length, 10);
});

test('новый визит через неделю: разделитель и приветствие по имени', () => {
  const session = fresh();
  session.transcript.push({ role: 'user', text: 'привет' });
  session.profile.name = 'Илья';
  session.profile.brew_methods = ['turka'];
  assert.equal(startVisit(session, 60 * 1000), false); // через минуту это тот же визит
  assert.equal(startVisit(session, 7 * DAY), true);
  assert.equal(session.visits, 2);
  const tail = session.transcript.slice(-2);
  assert.equal(tail[0].role, 'visit');
  assert.match(tail[0].text, /7 дней/);
  assert.match(tail[1].text, /С возвращением, Илья! .*для турки/);
  assert.match(systemPrompt(session, 7 * DAY), /вернулся спустя 7 дней/);
});

test('после заказа бот при возвращении спрашивает, как зашёл кофе', () => {
  const session = fresh();
  session.visits = 2;
  session.transcript.push({ role: 'user', text: 'x' });
  session.orders = [{ lines: [{ name: 'Бразилия Сантос' }] }];
  assert.match(greeting(session), /Как вам Бразилия Сантос\?/);
});

test('обрезка истории начинается с реплики клиента и не рвёт пары инструментов', () => {
  const history = [];
  for (let i = 0; i < 20; i += 1) {
    history.push({ role: 'user', content: `q${i}` });
    history.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}` }] });
    history.push({ role: 'tool', tool_call_id: `c${i}`, content: '{}' });
    history.push({ role: 'assistant', content: `a${i}` });
  }
  const trimmed = trimHistory(history, 10);
  assert.equal(trimmed[0].role, 'user');
  assert.ok(trimmed.length <= 10);
});
