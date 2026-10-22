import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGigaMessages, toGigaFunctions, createGigaChat } from '../lib/gigachat.js';
import { llmConfig } from '../lib/llm.js';
import { TOOLS } from '../lib/tools.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('история OpenAI превращается в цепочку function_call → function', () => {
  const out = toGigaMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'турка' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', function: { name: 'remember', arguments: '{"name":"Илья"}' } },
        { id: 'b', function: { name: 'search_products', arguments: '{"brew_method":"turka"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', content: '{"saved":["name"]}' },
    { role: 'tool', tool_call_id: 'b', content: '{"found":3}' },
    { role: 'tool', tool_call_id: 'lost', content: '{}' },
    { role: 'assistant', content: 'Вот' },
  ]);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'function', 'assistant', 'function', 'assistant']);
  assert.deepEqual(out[2].function_call, { name: 'remember', arguments: { name: 'Илья' } });
  assert.deepEqual(out[5], { role: 'function', name: 'search_products', content: '{"found":3}' });
});

test('инструменты передаются как functions', () => {
  const f = toGigaFunctions(TOOLS);
  assert.equal(f.length, TOOLS.length);
  assert.equal(f[0].name, 'search_products');
  assert.equal(f[0].parameters.type, 'object');
});

test('вызов функции от GigaChat приходит агенту в формате tool_calls, токен кэшируется', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('oauth')) return json({ access_token: 'tok', expires_at: Date.now() + 30 * 60_000 });
    const body = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    assert.ok(body.functions.length > 0);
    return json({ choices: [{ message: { role: 'assistant', content: '', function_call: { name: 'search_products', arguments: { query: 'кения' } }, functions_state_id: 'st-1' }, finish_reason: 'function_call' }] });
  };
  const llm = createGigaChat({ apiKey: 'key', model: 'GigaChat-2-Max' }, { fetchImpl });
  const r = await llm({ messages: [{ role: 'user', content: 'кения' }], tools: TOOLS });
  await llm({ messages: [{ role: 'user', content: 'кения' }], tools: TOOLS });
  assert.equal(r.toolCalls[0].function.name, 'search_products');
  assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { query: 'кения' });
  assert.equal(r.toolCalls[0].stateId, 'st-1');
  assert.equal(calls.filter((u) => u.includes('oauth')).length, 1);
});

test('текстовый ответ печатается по словам, при 402 запрос уходит следующей модели', async () => {
  const models = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('oauth')) return json({ access_token: 'tok', expires_at: Date.now() + 30 * 60_000 });
    const { model } = JSON.parse(init.body);
    models.push(model);
    if (model === 'GigaChat-2-Max') return json({ message: 'Payment Required' }, 402);
    return json({ choices: [{ message: { role: 'assistant', content: 'Берите Бразилию' }, finish_reason: 'stop' }] });
  };
  const llm = createGigaChat(llmConfig({ LLM_PROVIDER: 'gigachat', GIGACHAT_AUTH_KEY: 'k' }), { fetchImpl });
  const parts = [];
  const r = await llm({ messages: [], tools: [], onText: (d) => parts.push(d) });
  assert.equal(r.content, 'Берите Бразилию');
  assert.deepEqual(parts, ['Берите ', 'Бразилию']);
  assert.deepEqual(models, ['GigaChat-2-Max', 'GigaChat-2-Pro']);
  await llm({ messages: [], tools: [] });
  assert.equal(models.at(-1), 'GigaChat-2-Pro'); // закончившуюся модель больше не дёргаем
});

test('без ключа GigaChat не включается', () => {
  assert.equal(llmConfig({ LLM_PROVIDER: 'gigachat' }), null);
});

test('отказ «функционал временно недоступен» не доходит до клиента: запрос повторяется', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    if (url.includes('oauth')) return json({ access_token: 'tok', expires_at: Date.now() + 30 * 60_000 });
    n += 1;
    if (n === 1) return json({ choices: [{ message: { role: 'assistant', content: 'Функционал вызова функции временно недоступен. Попробую помочь советом.' }, finish_reason: 'stop' }] });
    return json({ choices: [{ message: { role: 'assistant', content: '', function_call: { name: 'search_products', arguments: {} } }, finish_reason: 'function_call' }] });
  };
  const parts = [];
  const llm = createGigaChat({ apiKey: 'k', model: 'GigaChat-2-Max' }, { fetchImpl });
  const r = await llm({ messages: [], tools: TOOLS, onText: (d) => parts.push(d) });
  assert.equal(r.toolCalls[0].function.name, 'search_products');
  assert.deepEqual(parts, []);
  assert.equal(n, 2);
});
