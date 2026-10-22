// Каталог и сведения о магазине. Бот не знает о товарах ничего, кроме того,
// что лежит в data/catalog.json: цены, наличие и состав берутся только отсюда.
import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));

export const CATALOG = load('catalog.json');
export const SHOP = load('shop.json');

export const CATEGORIES = {
  beans: 'кофе в зёрнах',
  drip: 'дрип-пакеты',
  grinder: 'кофемолки',
  brewer: 'заварники: воронки, френч-прессы, гейзеры, турки',
  kettle: 'чайники',
  accessory: 'аксессуары',
  machine: 'кофемашины',
};
export const METHODS = ['espresso', 'turka', 'moka', 'french', 'v60', 'aeropress', 'cup', 'drip'];
export const ROASTS = ['light', 'medium', 'medium-dark', 'dark'];

const byId = new Map(CATALOG.map((p) => [p.id, p]));
export const getProduct = (id) => byId.get(String(id)) ?? null;

export const formatRub = (n) => `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;

// Простейший «стемминг»: сравниваем начала слов, чтобы «шоколадный» находил «шоколад»,
// а «кислинки» находило «кислотность». Для каталога в сотню позиций этого хватает.
const STOP = new Set(['для', 'без', 'кофе', 'чтобы', 'какой', 'какое', 'какая', 'хочу', 'нужен', 'нужна', 'нужно', 'что', 'это', 'или']);
const words = (s) => String(s).toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]+/g) ?? [];
const stem = (w) => w.slice(0, Math.max(4, Math.min(6, w.length - 2)));

function haystack(p) {
  return words([p.name, p.origin, p.process, ...(p.notes ?? []), p.description, CATEGORIES[p.category]].join(' '));
}

export function searchProducts({ query = '', category, brew_method, roast, max_price, min_price, in_stock_only = false } = {}) {
  const terms = words(query).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
  const scored = [];
  for (const p of CATALOG) {
    if (category && p.category !== category) continue;
    if (brew_method && !(p.methods ?? []).includes(brew_method)) continue;
    if (roast && p.roast !== roast) continue;
    if (Number.isFinite(max_price) && p.price > max_price) continue;
    if (Number.isFinite(min_price) && p.price < min_price) continue;
    if (in_stock_only && p.stock <= 0) continue;
    const hay = haystack(p);
    const score = terms.reduce((s, t) => s + (hay.some((w) => w.startsWith(t)) ? 1 : 0), 0);
    if (terms.length && score === 0) continue;
    scored.push({ p, score });
  }
  // Сначала то, что лучше совпало по словам, затем то, что есть в наличии.
  scored.sort((a, b) => b.score - a.score || (b.p.stock > 0) - (a.p.stock > 0) || a.p.price - b.p.price);
  return scored.map((s) => s.p);
}

export function stockLabel(p) {
  if (p.stock <= 0) return p.restock ? `нет в наличии, ожидается ${p.restock}` : 'нет в наличии';
  if (p.stock <= 3) return `осталось ${p.stock} шт`;
  return 'в наличии';
}

// Короткая запись товара для модели: всё, что нужно для совета, и ничего лишнего.
export function productForModel(p) {
  const out = {
    id: p.id,
    name: p.name,
    category: p.category,
    price: `${formatRub(p.price)} за ${p.unit}`,
    stock: stockLabel(p),
  };
  if (p.roast) out.roast = SHOP.glossary[p.roast];
  if (p.notes) out.notes = p.notes.join(', ');
  if (p.acidity) out.acidity = `${p.acidity}/5`;
  if (p.body) out.body = `${p.body}/5`;
  if (p.methods) out.methods = p.methods.join(', ');
  if (p.origin) out.origin = p.origin;
  out.description = p.description;
  return out;
}

// Карточка товара для чата: то, что рисует браузер.
export function productForCard(p) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    price: p.price,
    unit: p.unit,
    stock: p.stock,
    stockLabel: stockLabel(p),
    roast: p.roast ?? null,
    notes: p.notes ?? [],
  };
}
