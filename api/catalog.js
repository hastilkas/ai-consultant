// GET /api/catalog — каталог для карточек в чате и витрины «что знает бот».
import { CATALOG, CATEGORIES, SHOP, productForCard } from '../lib/catalog.js';
import { sendJson } from '../lib/http.js';

export default function handler(req, res) {
  sendJson(res, 200, {
    shop: { name: SHOP.name, assistant: SHOP.assistant, phone: SHOP.phone, hours: SHOP.hours },
    categories: CATEGORIES,
    products: CATALOG.map(productForCard),
  }, { 'Cache-Control': 'public, max-age=300' });
}
