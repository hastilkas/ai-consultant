// Клиент для любого OpenAI-совместимого API: DeepSeek, OpenRouter, OpenAI,
// YandexGPT (режим совместимости), локальные LM Studio и Ollama.
// Провайдер меняется тремя переменными окружения, код трогать не нужно.

export class LlmError extends Error {}

export function llmConfig(env = process.env) {
  if (env.LLM_PROVIDER === 'gigachat') {
    const apiKey = env.GIGACHAT_AUTH_KEY?.trim();
    if (!apiKey) return null;
    return {
      provider: 'gigachat',
      apiKey,
      scope: env.GIGACHAT_SCOPE?.trim() || 'GIGACHAT_API_PERS',
      model: env.LLM_MODEL?.trim() || 'GigaChat-2-Max,GigaChat-2-Pro,GigaChat-2',
      temperature: Number(env.LLM_TEMPERATURE ?? 0.4),
    };
  }
  const apiKey = env.LLM_API_KEY?.trim();
  const baseUrl = (env.LLM_BASE_URL?.trim() || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = env.LLM_MODEL?.trim() || 'deepseek-chat';
  if (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl)) return null;
  return { provider: 'openai', apiKey, baseUrl, model, temperature: Number(env.LLM_TEMPERATURE ?? 0.4) };
}

// Разбирает поток Server-Sent Events от провайдера. Текст отдаёт в onText по кусочкам,
// вызовы инструментов собирает целиком: их аргументы приходят частями.
export async function parseStream(body, onText) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = null;
  const calls = [];

  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new LlmError(chunk.error.message ?? 'ошибка провайдера');
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      calls[i] ??= { id: '', name: '', arguments: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
    }
  }
  handle(buffer.trim());

  const toolCalls = calls.filter(Boolean).map((c, i) => ({
    id: c.id || `call_${i}`,
    type: 'function',
    function: { name: c.name, arguments: c.arguments || '{}' },
  }));
  return { content, toolCalls, finishReason };
}

export function createLlm(config, { fetchImpl = fetch } = {}) {
  return async function complete({ messages, tools, maxTokens = 700, onText }) {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: config.temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(`LLM ${res.status}: ${text.slice(0, 300)}`);
    }
    return parseStream(res.body, onText);
  };
}
