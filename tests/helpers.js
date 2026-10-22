// Поддельная модель: отвечает по сценарию, который задаёт тест.
// Каждый шаг — либо текст, либо список вызовов инструментов.
export function scriptedLlm(steps) {
  const calls = [];
  const llm = async ({ messages, onText }) => {
    calls.push(messages);
    const step = steps.shift();
    if (!step) throw new Error('сценарий закончился');
    if (step.error) throw new Error(step.error);
    if (step.text) {
      for (const part of step.text.match(/.{1,7}/gs)) onText?.(part);
      return { content: step.text, toolCalls: [] };
    }
    return {
      content: step.say ?? '',
      toolCalls: step.tools.map(([name, args], i) => ({
        id: `call_${calls.length}_${i}`,
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      })),
    };
  };
  llm.calls = calls;
  return llm;
}

export function fakeNotifier() {
  const sent = [];
  return {
    sent,
    order: async (order) => {
      sent.push({ kind: 'order', order });
      return `order ${order.no}`;
    },
    handoff: async (info) => {
      sent.push({ kind: 'handoff', info });
      return `handoff ${info.reason}`;
    },
  };
}

// Превращает строки в поток байтов, как его отдаёт fetch.
export async function* byteStream(chunks) {
  const enc = new TextEncoder();
  for (const c of chunks) yield enc.encode(c);
}
