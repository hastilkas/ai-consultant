import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, searchProducts, getProduct, productForModel, stockLabel, formatRub } from '../lib/catalog.js';

test('в каталоге уникальные id и у каждого товара есть цена и наличие', () => {
  const ids = CATALOG.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of CATALOG) {
    assert.ok(p.price > 0, p.id);
    assert.ok(Number.isInteger(p.stock), p.id);
  }
});

test('фильтр по способу заваривания и цене', () => {
  const found = searchProducts({ category: 'beans', brew_method: 'turka', max_price: 700 });
  assert.ok(found.length > 0);
  for (const p of found) {
    assert.ok(p.methods.includes('turka'));
    assert.ok(p.price <= 700);
  }
});

test('поиск по словам понимает другие формы слова', () => {
  const ids = searchProducts({ query: 'шоколадный' }).map((p) => p.id);
  assert.ok(ids.includes('brazil-santos'));
  const eth = searchProducts({ query: 'Эфиопии' });
  assert.ok(eth.some((p) => p.id === 'eth-yirgacheffe'));
  assert.ok(eth.every((p) => `${p.name} ${p.origin}`.includes('Эфиопия')));
});

test('товары в наличии идут раньше закончившихся', () => {
  const found = searchProducts({ query: 'какао' });
  const firstOut = found.findIndex((p) => p.stock <= 0);
  if (firstOut >= 0) assert.ok(found.slice(firstOut).every((p) => p.stock <= 0));
});

test('несуществующий товар не находится', () => {
  assert.equal(getProduct('iphone-17'), null);
  assert.deepEqual(searchProducts({ query: 'айфон' }), []);
});

test('модель видит наличие и дату поступления', () => {
  const out = productForModel(getProduct('guatemala-antigua'));
  assert.match(out.stock, /нет в наличии, ожидается/);
  assert.equal(stockLabel(getProduct('eth-guji-natural')), 'осталось 3 шт');
  assert.equal(formatRub(24990), '24 990 ₽');
});
