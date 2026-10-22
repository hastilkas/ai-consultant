// GigaChat от Сбера: бесплатно для физлиц (365 млн токенов на год), работает из России.
// У него свой формат вызова функций (старый OpenAI-формат functions/function_call,
// по одному вызову за раз), поэтому здесь переводчик туда и обратно: агент
// остаётся одним и тем же для любой нейросети.
import { readFileSync, existsSync } from 'node:fs';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { LlmError } from './llm.js';

const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const API_URL = 'https://gigachat.devices.sberbank.ru/api/v1';

// Серверы Сбера подписаны сертификатом Минцифры, которого нет в Node.js «из коробки».
// Добавляем его к стандартным корневым сертификатам один раз при загрузке.
const CA_FILE = new URL('../certs/russian_trusted_root_ca.pem', import.meta.url);
let caReady = false;
export function trustRussianCa() {
  if (caReady || !existsSync(CA_FILE)) return caReady;
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), readFileSync(CA_FILE, 'utf8')]);
  caReady = true;
  return true;
}

// OpenAI-сообщения → сообщения GigaChat. Несколько вызовов инструментов
// в одном ответе раскладываются в цепочку «вызов → результат».
export function toGigaMessages(messages) {
  const out = [];
  const names = new Map();
  const pending = new Map(); // id вызова → сообщение assistant, которое ещё не выведено
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      if (m.content) out.push({ role: 'assistant', content: m.content });
      for (const c of m.tool_calls) {
        names.set(c.id, c.function.name);
        let args;
        try {
          args = JSON.parse(c.function.arguments || '{}');
        } catch {
          args = {};
        }
        pending.set(c.id, {
          role: 'assistant',
          content: '',
          function_call: { name: c.function.name, arguments: args },
          ...(c.stateId ? { functions_state_id: c.stateId } : {}),
        });
      }
    } else if (m.role === 'tool') {
      const call = pending.get(m.tool_call_id);
      if (!call) continue; // результат без вызова (обрезанная история) модели не нужен
      pending.delete(m.tool_call_id);
      out.push(call, { role: 'function', name: names.get(m.tool_call_id), content: m.content });
    } else {
      out.push({ role: m.role, content: m.content ?? '' });
    }
  }
  return out;
}

export function toGigaFunctions(tools = []) {
  return tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
}

export function createGigaChat(config, { fetchImpl = fetch } = {}) {
  let token = null;
  let expiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < expiresAt - 60_000) return token;
    const res = await fetchImpl(config.oauthUrl ?? OAUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${config.apiKey}`,
        RqUID: randomUUID(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: `scope=${config.scope ?? 'GIGACHAT_API_PERS'}`,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new LlmError(`GigaChat OAuth ${res.status}: ${data.message ?? ''}`);
    token = data.access_token;
    expiresAt = data.expires_at ?? Date.now() + 25 * 60_000;
    return token;
  }

  // Модели через запятую: если у первой кончились бесплатные токены (402),
  // запрос уходит следующей. Например: GigaChat-2-Max,GigaChat-2-Pro,GigaChat-2
  const models = String(config.model).split(',').map((m) => m.trim()).filter(Boolean);
  let current = 0;

  // Иногда GigaChat вместо вызова функции пишет «функционал вызова функции временно
  // недоступен» и советует из головы. Такой ответ клиенту не показываем, а переспрашиваем.
  const REFUSED_TOOLS = /функци\S*\s+(?:\S+\s+){0,3}(?:временно|недоступ|ограничен)/i;

  return async function complete(args) {
    for (let attempt = 0; ; attempt += 1) {
      const text = [];
      const reply = await completeModel({ ...args, onText: (d) => text.push(d) });
      if (attempt < 2 && !reply.toolCalls.length && REFUSED_TOOLS.test(reply.content)) {
        console.warn('GigaChat отказался вызывать функцию, повторяю запрос');
        continue;
      }
      for (const d of text) args.onText?.(d);
      return reply;
    }
  };

  async function completeModel(args) {
    for (;;) {
      try {
        return await completeWith(models[current], args);
      } catch (err) {
        if (err.status === 402 && current < models.length - 1) {
          console.warn(`GigaChat: у ${models[current]} закончились токены, переключаюсь на ${models[current + 1]}`);
          current += 1;
          continue;
        }
        throw err;
      }
    }
  };

  async function completeWith(model, { messages, tools, maxTokens = 700, onText }) {
    trustRussianCa();
    const res = await fetchImpl(`${config.baseUrl ?? API_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
      body: JSON.stringify({
        model,
        messages: toGigaMessages(messages),
        functions: toGigaFunctions(tools),
        function_call: 'auto',
        temperature: config.temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (res.status === 401) token = null;
    if (!res.ok) {
      const err = new LlmError(`GigaChat ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};

    if (msg.function_call) {
      const args = msg.function_call.arguments;
      return {
        content: '',
        toolCalls: [{
          id: msg.functions_state_id ?? `giga_${randomUUID()}`,
          stateId: msg.functions_state_id,
          type: 'function',
          function: { name: msg.function_call.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
        }],
        finishReason: 'tool_calls',
      };
    }
    // Ответ приходит целиком; отдаём его словами, чтобы чат печатал так же, как с потоковыми моделями.
    const content = msg.content ?? '';
    for (const part of content.match(/\S+\s*|\s+/g) ?? []) onText?.(part);
    return { content, toolCalls: [], finishReason: data.choices?.[0]?.finish_reason ?? 'stop' };
  }
}
