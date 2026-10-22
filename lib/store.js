// Хранилище диалогов и счётчиков. Два варианта с одинаковым интерфейсом:
//  • в памяти процесса — для локального запуска и тестов;
//  • Upstash Redis через REST — для Vercel, где память функции живёт недолго.
// Upstash подключается одной кнопкой в Vercel Marketplace, бесплатного тарифа хватает с запасом.

export class MemoryStore {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.data = new Map();
  }

  #alive(key) {
    const item = this.data.get(key);
    if (!item) return null;
    if (item.exp && item.exp <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return item;
  }

  async get(key) {
    const item = this.#alive(key);
    return item ? structuredClone(item.value) : null;
  }

  async set(key, value, ttlSec) {
    this.data.set(key, { value: structuredClone(value), exp: ttlSec ? this.now() + ttlSec * 1000 : 0 });
  }

  // Возвращает true, если ключа не было (замок или защита от повторной обработки).
  async setNx(key, value, ttlSec) {
    if (this.#alive(key)) return false;
    await this.set(key, value, ttlSec);
    return true;
  }

  async del(key) {
    this.data.delete(key);
  }

  async incr(key, ttlSec) {
    const item = this.#alive(key);
    const value = (item?.value ?? 0) + 1;
    this.data.set(key, { value, exp: item?.exp || (ttlSec ? this.now() + ttlSec * 1000 : 0) });
    return value;
  }
}

export class UpstashStore {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #call(path, body) {
    const res = await this.fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}: ${await res.text().catch(() => '')}`);
    return res.json();
  }

  async get(key) {
    const { result } = await this.#call('', ['GET', key]);
    return result == null ? null : JSON.parse(result);
  }

  async set(key, value, ttlSec) {
    const cmd = ['SET', key, JSON.stringify(value)];
    if (ttlSec) cmd.push('EX', ttlSec);
    await this.#call('', cmd);
  }

  async setNx(key, value, ttlSec) {
    const { result } = await this.#call('', ['SET', key, JSON.stringify(value), 'NX', 'EX', ttlSec]);
    return result === 'OK';
  }

  async del(key) {
    await this.#call('', ['DEL', key]);
  }

  async incr(key, ttlSec) {
    const [{ result }] = await this.#call('/pipeline', [['INCR', key], ['EXPIRE', key, ttlSec, 'NX']]);
    return result;
  }
}

let shared;
export function getStore(env = process.env) {
  if (shared) return shared;
  // Vercel Marketplace называет переменные KV_REST_API_*, сам Upstash — UPSTASH_REDIS_REST_*.
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  shared = url && token ? new UpstashStore({ url, token }) : new MemoryStore();
  return shared;
}
