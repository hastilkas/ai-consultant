import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool, normalizePhone, formatPhone, cartSummary, TOOLS } from '../lib/tools.js';
import { newSession } from '../lib/agent.js';
import { fakeNotifier } from './helpers.js';

const ctx = () => ({ session: newSession('test-session-0001'), notify: fakeNotifier() });

test('описания инструментов в формате OpenAI', () => {
  for (const t of TOOLS) {
    assert.equal(t.type, 'function');
    assert.equal(t.function.parameters.type, 'object');
  }
});

test('поиск без совпадений по словам ослабляет фильтр, а не возвращает пустоту', async () => {
  const out = await runTool('search_products', { query: 'для мамы на день рождения', category: 'drip' }, ctx());
  assert.ok(out.result.found > 0);
  assert.ok(out.result.note);
});

test('show_products не показывает выдуманные товары', async () => {
  const c = ctx();
  const bad = await runTool('show_products', { ids: ['fake-1'] }, c);
  assert.ok(bad.failed);
  const ok = await runTool('show_products', { ids: ['brazil-santos', 'fake-1'] }, c);
  assert.deepEqual(ok.events[0].products.map((p) => p.id), ['brazil-santos']);
  assert.deepEqual(ok.result.unknown, ['fake-1']);
});

test('remember дописывает профиль и не дублирует', async () => {
  const c = ctx();
  await runTool('remember', { name: 'Илья', brew_methods: ['turka'], taste: 'без кислинки' }, c);
  const again = await runTool('remember', { brew_methods: ['turka', 'nonsense'], note: 'покупает в подарок' }, c);
  assert.deepEqual(c.session.profile.brew_methods, ['turka']);
  assert.deepEqual(again.events[0].changed, ['notes']);
  assert.equal(c.session.profile.name, 'Илья');
});

test('remember не принимает «друг-кофеман» за имя клиента', async () => {
  const c = ctx();
  await runTool('remember', { name: 'друг-кофеман', taste: 'шоколад' }, c);
  assert.equal(c.session.profile.name, undefined);
  await runTool('remember', { name: 'Петя' }, c);
  assert.equal(c.session.profile.name, 'Петя');
});

test('корзина: нет в наличии нельзя, больше склада нельзя', async () => {
  const c = ctx();
  assert.ok((await runTool('update_cart', { items: [{ id: 'guatemala-antigua', qty: 1 }] }, c)).failed);
  const out = await runTool('update_cart', { items: [{ id: 'eth-guji-natural', qty: 10 }] }, c);
  assert.equal(c.session.cart[0].qty, 3);
  assert.ok(out.result.notes[0].includes('только 3'));
  await runTool('update_cart', { items: [{ id: 'eth-guji-natural', qty: 0 }] }, c);
  assert.deepEqual(c.session.cart, []);
});

// Заказ проходит в два хода: итог → реплика клиента → подтверждение.
async function confirmOrder(c, args) {
  c.session.turn = 1;
  const preview = await runTool('place_order', { ...args, confirmed_by_client: false }, c);
  c.session.turn = 2;
  return { preview, done: await runTool('place_order', { ...args, confirmed_by_client: true }, c) };
}

test('заказ без подтверждения клиента не оформляется, даже если модель сразу пишет true', async () => {
  const c = ctx();
  c.session.turn = 1;
  await runTool('update_cart', { items: [{ id: 'brazil-santos', qty: 2 }] }, c);
  const args = { name: 'Илья', phone: '89161234567', delivery: 'pickup' };
  const rush = await runTool('place_order', { ...args, confirmed_by_client: true }, c);
  assert.equal(rush.result.status, 'нужно подтверждение клиента');
  // В том же ответе подтвердить нельзя: клиент ещё не видел итог
  const same = await runTool('place_order', { ...args, confirmed_by_client: true }, c);
  assert.equal(same.result.status, 'нужно подтверждение клиента');
  assert.equal(c.notify.sent.length, 0);
  // Клиент ответил, но корзина изменилась — нужен новый итог
  c.session.turn = 2;
  await runTool('update_cart', { items: [{ id: 'brazil-santos', qty: 3 }] }, c);
  const changed = await runTool('place_order', { ...args, confirmed_by_client: true }, c);
  assert.equal(changed.result.status, 'нужно подтверждение клиента');
  c.session.turn = 3;
  assert.equal((await runTool('place_order', { ...args, confirmed_by_client: true }, c)).result.ok, true);
  assert.equal(c.notify.sent.length, 1);
});

test('сумма заказа считается сервером, а не берётся из слов модели', async () => {
  const c = ctx();
  await runTool('update_cart', { items: [{ id: 'brazil-santos', qty: 2 }, { id: 'turka-copper', qty: 1 }] }, c);
  const { preview, done: out } = await confirmOrder(c, {
    name: 'Илья', phone: '8 (916) 123-45-67', delivery: 'courier', address: 'Москва, ул. Ленина, 5', total: 1,
  });
  assert.equal(preview.result.total, '3 170 ₽');
  assert.ok(!out.failed, out.summary);
  const order = c.notify.sent[0].order;
  assert.equal(order.subtotal, 590 * 2 + 1990);
  assert.equal(order.deliveryCost, 0); // от 3000 ₽ курьер бесплатно
  assert.equal(order.phone, '79161234567');
  assert.deepEqual(c.session.cart, []);
  assert.ok(out.events.some((e) => e.type === 'owner'));
});

test('курьер без адреса и кривой телефон отклоняются', async () => {
  const c = ctx();
  await runTool('update_cart', { items: [{ id: 'brazil-santos', qty: 1 }] }, c);
  assert.ok((await runTool('place_order', { name: 'А', phone: '123', delivery: 'pickup', confirmed_by_client: true }, c)).failed);
  assert.ok((await runTool('place_order', { name: 'А', phone: '+79161234567', delivery: 'courier', confirmed_by_client: true }, c)).failed);
  const { done: ok } = await confirmOrder(c, { name: 'А', phone: '+79161234567', delivery: 'courier', address: 'Тверская 1' });
  assert.equal(c.notify.sent[0].order.deliveryCost, 350);
  assert.ok(!ok.failed);
});

test('сломанные аргументы и неизвестный инструмент не роняют диалог', async () => {
  assert.ok((await runTool('search_products', '{oops', ctx())).failed);
  assert.ok((await runTool('drop_database', {}, ctx())).failed);
});

test('телефон: 8, +7, 9…, иностранный', () => {
  assert.equal(normalizePhone('8 916 123-45-67'), '79161234567');
  assert.equal(normalizePhone('9161234567'), '79161234567');
  assert.equal(normalizePhone('+375 29 123-45-67'), '375291234567');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(formatPhone('79161234567'), '+7 (916) 123-45-67');
});

test('доставка СДЭК добавляется к сумме', () => {
  const s = cartSummary([{ id: 'brazil-santos', qty: 1 }], 'cdek');
  assert.equal(s.total, 590 + 290);
});
