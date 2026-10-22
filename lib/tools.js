// Инструменты, которыми пользуется модель. Каждый проверяет аргументы сам:
// модель может ошибиться или поддаться на уговоры, поэтому всё, что касается
// денег и наличия, считается здесь, а не в тексте ответа.
import {
  CATALOG, CATEGORIES, METHODS, ROASTS, SHOP, getProduct, searchProducts,
  productForModel, productForCard, formatRub,
} from './catalog.js';

const MAX_QTY = 20;
const MAX_ORDERS_PER_SESSION = 3;
export const DELIVERY = {
  courier: { title: 'Курьер по Москве', cost: (sum) => (sum >= 3000 ? 0 : 350), needsAddress: true },
  cdek: { title: 'СДЭК по России', cost: () => 290, needsAddress: true, approx: true },
  pickup: { title: 'Самовывоз, ул. Примерная, 12', cost: () => 0, needsAddress: false },
};

export class ToolError extends Error {}

const clip = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => (v === '' || v == null ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`;
  if (d.length === 10 && d[0] === '9') d = `7${d}`;
  if (d.length === 11 && d[0] === '7') return d;
  return d.length >= 10 && d.length <= 15 && String(raw).trim().startsWith('+') ? d : null;
}

export function formatPhone(d) {
  if (d.length === 11 && d[0] === '7') return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  return `+${d}`;
}

export function cartSummary(cart, delivery) {
  const lines = cart
    .map(({ id, qty }) => {
      const p = getProduct(id);
      return p ? { id, name: p.name, unit: p.unit, price: p.price, qty, sum: p.price * qty } : null;
    })
    .filter(Boolean);
  const subtotal = lines.reduce((s, l) => s + l.sum, 0);
  const d = delivery ? DELIVERY[delivery] : null;
  const deliveryCost = d ? d.cost(subtotal) : null;
  return { lines, subtotal, delivery, deliveryCost, total: subtotal + (deliveryCost ?? 0) };
}

export const TOOL_DEFS = [
  {
    name: 'search_products',
    description: 'Ищет товары в каталоге магазина. Вызывай перед любым советом о товаре, ценах и наличии. Можно вызывать несколько раз с разными фильтрами.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Слова для поиска: вкусовые ноты, страна, название. Например: "шоколад орех", "Эфиопия", "кофемолка".' },
        category: { type: 'string', enum: Object.keys(CATEGORIES) },
        brew_method: { type: 'string', enum: METHODS, description: 'Способ заваривания, под который подходит товар' },
        roast: { type: 'string', enum: ROASTS },
        max_price: { type: 'number', description: 'Максимальная цена за единицу, ₽' },
        min_price: { type: 'number' },
        in_stock_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'show_products',
    description: 'Показывает клиенту карточки товаров с фото, ценой и кнопкой «В корзину». Вызывай, когда рекомендуешь конкретные товары: 1–3 самых подходящих.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
      required: ['ids'],
    },
  },
  {
    name: 'remember',
    description: 'Запоминает факты о клиенте надолго: они будут доступны и при следующих визитах. Вызывай сразу, как клиент сообщил что-то полезное о себе. Передавай только новые или изменившиеся поля.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя самого клиента, только если он его назвал. Не «друг», не «коллега»' },
        brew_methods: { type: 'array', items: { type: 'string', enum: METHODS }, description: 'Чем клиент варит кофе' },
        taste: { type: 'string', description: 'Вкусовые предпочтения своими словами: "без кислинки, любит шоколад"' },
        budget: { type: 'string', description: 'Бюджет: "до 1000 ₽ за пачку"' },
        equipment: { type: 'string', description: 'Что уже есть: "ручная кофемолка, индукционная плита"' },
        note: { type: 'string', description: 'Другой важный факт: для кого покупает, повод, аллергия и т.п. Вкусы человека, которому выбирают подарок, пиши сюда, а не в taste и brew_methods.' },
      },
    },
  },
  {
    name: 'update_cart',
    description: 'Меняет корзину клиента: qty — итоговое количество позиции, 0 удаляет её. Вызывай, только когда клиент явно попросил добавить или убрать товар.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, qty: { type: 'integer', minimum: 0, maximum: MAX_QTY } },
            required: ['id', 'qty'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'place_order',
    description: 'Оформляет заказ из корзины в два шага. Шаг 1: когда известны имя, телефон и доставка, вызови с confirmed_by_client=false — получишь итог, покажи его клиенту и спроси «Оформляю?». Шаг 2: после согласия клиента вызови с теми же данными и confirmed_by_client=true.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        delivery: { type: 'string', enum: Object.keys(DELIVERY) },
        address: { type: 'string', description: 'Адрес для курьера или город и пункт СДЭК' },
        comment: { type: 'string', description: 'Пожелания: помол, время доставки, упаковка в подарок' },
        confirmed_by_client: { type: 'boolean', description: 'false — показать итог; true — только если клиент уже увидел итог и согласился' },
      },
      required: ['name', 'phone', 'delivery', 'confirmed_by_client'],
    },
  },
  {
    name: 'call_manager',
    description: 'Зовёт живого менеджера: жалоба, опт, вопрос, на который нет ответа в данных магазина, или клиент сам просит человека.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Коротко, в чём вопрос' },
        contact: { type: 'string', description: 'Телефон или другой контакт клиента, если он его дал' },
      },
      required: ['reason'],
    },
  },
];

export const TOOLS = TOOL_DEFS.map(({ name, description, parameters }) => ({
  type: 'function',
  function: { name, description, parameters },
}));

const METHOD_TITLES = SHOP.glossary;

// Каждый обработчик возвращает { result } для модели и события для интерфейса.
const handlers = {
  search_products(args) {
    const filters = {
      query: clip(args.query, 100),
      category: CATEGORIES[args.category] ? args.category : undefined,
      brew_method: METHODS.includes(args.brew_method) ? args.brew_method : undefined,
      roast: ROASTS.includes(args.roast) ? args.roast : undefined,
      max_price: num(args.max_price),
      min_price: num(args.min_price),
      in_stock_only: args.in_stock_only === true,
    };
    let found = searchProducts(filters);
    let relaxed = false;
    // Если по словам ничего не нашлось, повторяем только по фильтрам: модель
    // часто пишет в query то, чего нет в описаниях («для мамы», «покрепче»).
    if (!found.length && filters.query) {
      found = searchProducts({ ...filters, query: '' });
      relaxed = found.length > 0;
    }
    const top = found.slice(0, 6);
    const parts = [];
    if (filters.query) parts.push(`«${filters.query}»`);
    if (filters.category) parts.push(CATEGORIES[filters.category]);
    if (filters.brew_method) parts.push(METHOD_TITLES[filters.brew_method]);
    if (filters.roast) parts.push(METHOD_TITLES[filters.roast].split(':')[0]);
    if (filters.max_price) parts.push(`до ${formatRub(filters.max_price)}`);
    return {
      result: {
        found: found.length,
        note: relaxed ? 'По словам из query точных совпадений нет, показаны товары только по фильтрам.' : undefined,
        products: top.map(productForModel),
      },
      summary: `Поиск в каталоге: ${parts.join(', ') || 'всё'} → ${found.length ? `найдено ${found.length}` : 'ничего'}`,
    };
  },

  show_products(args) {
    const ids = [...new Set((Array.isArray(args.ids) ? args.ids : []).map(String))].slice(0, 4);
    const products = ids.map(getProduct).filter(Boolean);
    const unknown = ids.filter((id) => !getProduct(id));
    if (!products.length) throw new ToolError(`Таких товаров нет в каталоге: ${unknown.join(', ')}. Сначала найди их через search_products.`);
    return {
      result: { shown: products.map((p) => p.name), unknown: unknown.length ? unknown : undefined },
      events: [{ type: 'products', products: products.map(productForCard) }],
      transcript: { role: 'products', ids: products.map((p) => p.id) },
      summary: `Показала карточки: ${products.map((p) => p.name).join(', ')}`,
    };
  },

  remember(args, { session }) {
    const p = session.profile;
    const changed = [];
    for (const key of ['name', 'taste', 'budget', 'equipment']) {
      const v = clip(args[key], 120);
      // GigaChat любит записывать в имя «друг-кофеман» или «коллега», когда выбирают подарок.
      if (key === 'name' && NOT_A_NAME.test(v)) continue;
      if (v && v !== p[key]) {
        p[key] = v;
        changed.push(key);
      }
    }
    if (Array.isArray(args.brew_methods)) {
      const methods = [...new Set([...(p.brew_methods ?? []), ...args.brew_methods.filter((m) => METHODS.includes(m))])];
      if (methods.length !== (p.brew_methods ?? []).length) {
        p.brew_methods = methods;
        changed.push('brew_methods');
      }
    }
    const note = clip(args.note, 160);
    if (note && !(p.notes ?? []).includes(note)) {
      p.notes = [...(p.notes ?? []), note].slice(-5);
      changed.push('notes');
    }
    return {
      result: { saved: changed.length ? changed : 'ничего нового' },
      events: [{ type: 'profile', profile: p, changed }],
      summary: changed.length ? `Запомнила: ${changed.map((k) => PROFILE_TITLES[k]).join(', ')}` : 'Запоминать нечего: это уже известно',
    };
  },

  update_cart(args, { session }) {
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) throw new ToolError('Пустой список позиций.');
    const notes = [];
    for (const it of items) {
      const p = getProduct(it.id);
      if (!p) throw new ToolError(`Товара ${it.id} нет в каталоге.`);
      let qty = Math.max(0, Math.min(MAX_QTY, Math.round(Number(it.qty) || 0)));
      if (qty > 0 && p.stock <= 0) throw new ToolError(`«${p.name}» нет в наличии, добавить нельзя.`);
      if (qty > p.stock) {
        notes.push(`«${p.name}»: на складе только ${p.stock} шт, положила ${p.stock}`);
        qty = p.stock;
      }
      setCartQty(session, p.id, qty);
    }
    const sum = cartSummary(session.cart);
    return {
      result: {
        cart: sum.lines.map((l) => `${l.name} × ${l.qty} = ${formatRub(l.sum)}`),
        subtotal: formatRub(sum.subtotal),
        free_courier_from: formatRub(3000),
        notes: notes.length ? notes : undefined,
      },
      events: [{ type: 'cart', cart: sum }],
      summary: `Корзина: ${sum.lines.length ? `${sum.lines.length} поз. на ${formatRub(sum.subtotal)}` : 'пусто'}`,
    };
  },

  // Заказ оформляется в два шага, и это проверяет сервер, а не промпт:
  // 1) confirmed_by_client=false — проверка данных и итог, который бот показывает клиенту;
  // 2) confirmed_by_client=true — только в следующем ответе, после реплики клиента,
  //    и только если корзина и данные не изменились.
  async place_order(args, { session, notify }) {
    if (!session.cart.length) throw new ToolError('Корзина пуста: сначала добавь товары через update_cart.');
    if ((session.orders ?? []).length >= MAX_ORDERS_PER_SESSION) throw new ToolError('Лимит заказов в одном диалоге исчерпан, предложи позвать менеджера.');
    const name = clip(args.name, 60);
    if (!name) throw new ToolError('Нужно имя клиента.');
    const phone = normalizePhone(args.phone);
    if (!phone) throw new ToolError('Телефон выглядит неправильно, переспроси у клиента.');
    const delivery = DELIVERY[args.delivery] ? args.delivery : null;
    if (!delivery) throw new ToolError('Неизвестный способ доставки: courier, cdek или pickup.');
    const address = DELIVERY[delivery].needsAddress ? clip(args.address, 200) : '';
    if (DELIVERY[delivery].needsAddress && address.length < 5) throw new ToolError('Для этой доставки нужен адрес.');
    for (const { id, qty } of session.cart) {
      const p = getProduct(id);
      if (!p || p.stock < qty) throw new ToolError(`«${p?.name ?? id}» уже нет в нужном количестве, обнови корзину.`);
    }

    const sum = cartSummary(session.cart, delivery);
    const key = JSON.stringify([name, phone, delivery, address, session.cart]);
    const pending = session.pendingOrder;
    const confirmable = pending && pending.key === key && pending.turn < (session.turn ?? 0);

    if (args.confirmed_by_client !== true || !confirmable) {
      session.pendingOrder = { key, turn: session.turn ?? 0 };
      return {
        result: {
          status: 'нужно подтверждение клиента',
          items: sum.lines.map((l) => `${l.name} × ${l.qty} = ${formatRub(l.sum)}`),
          delivery: `${DELIVERY[delivery].title}${address ? `, ${address}` : ''}: ${sum.deliveryCost === 0 ? 'бесплатно' : formatRub(sum.deliveryCost)}${DELIVERY[delivery].approx ? ' (предварительно)' : ''}`,
          total: formatRub(sum.total),
          contact: `${name}, ${formatPhone(phone)}`,
          next: 'Покажи клиенту этот итог одним сообщением и спроси «Оформляю?». Заказ ещё НЕ оформлен. Когда клиент ответит согласием, вызови place_order с теми же данными и confirmed_by_client=true.',
        },
        summary: `Подготовила заказ на ${formatRub(sum.total)}, жду подтверждения клиента`,
      };
    }
    session.pendingOrder = null;

    const order = {
      no: String(1000 + Math.floor(Math.random() * 9000)),
      at: Date.now(),
      name,
      phone,
      delivery,
      address,
      comment: clip(args.comment, 300),
      ...sum,
    };
    session.orders = [...(session.orders ?? []), order];
    session.cart = [];
    if (!session.profile.name) session.profile.name = name;
    const owner = await notify.order(order, session);

    return {
      result: {
        ok: true,
        order_no: order.no,
        total: formatRub(order.total),
        delivery_note: DELIVERY[delivery].approx ? 'стоимость СДЭК предварительная, менеджер уточнит' : undefined,
        next: 'Менеджер позвонит или напишет в течение 15 минут в рабочее время, чтобы подтвердить заказ и прислать ссылку на оплату.',
      },
      events: [{ type: 'cart', cart: cartSummary([]) }, { type: 'order', order }, ...(owner ? [{ type: 'owner', text: owner }] : [])],
      summary: `Оформила заказ № ${order.no} на ${formatRub(order.total)} и отправила менеджеру`,
    };
  },

  async call_manager(args, { session, notify }) {
    const reason = clip(args.reason, 300);
    if (!reason) throw new ToolError('Укажи причину.');
    const owner = await notify.handoff({ reason, contact: clip(args.contact, 100) }, session);
    return {
      result: { ok: true, next: `Менеджер подключится в рабочее время (${SHOP.hours}). Телефон магазина: ${SHOP.phone}.` },
      events: owner ? [{ type: 'owner', text: owner }] : [],
      summary: `Позвала менеджера: ${reason}`,
    };
  },
};

const NOT_A_NAME = /друг|подруг|коллег|клиент|покупател|кофеман|мам|пап|муж|жен|брат|сестр|начальн|\s.*\s/i;

export const PROFILE_TITLES = {
  name: 'имя', brew_methods: 'способ заваривания', taste: 'вкус', budget: 'бюджет', equipment: 'что уже есть', notes: 'заметки',
};

export function setCartQty(session, id, qty) {
  const rest = session.cart.filter((l) => l.id !== id);
  session.cart = qty > 0 ? [...rest, { id, qty }] : rest;
}

export async function runTool(name, rawArgs, ctx) {
  const handler = handlers[name];
  if (!handler) return { result: { error: `Нет инструмента ${name}` }, summary: `Неизвестный инструмент ${name}`, failed: true };
  let args;
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs ?? {};
  } catch {
    return { result: { error: 'Аргументы не в формате JSON' }, summary: `${name}: сломанные аргументы`, failed: true };
  }
  try {
    return { ...(await handler(args, ctx)), args };
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    return { result: { error: err.message }, summary: `${name}: ${err.message}`, failed: true, args };
  }
}

export const catalogSize = CATALOG.length;
