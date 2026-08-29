'use strict';

// ДЗ-09 — Variant Б: runtime-валідація на кордоні.
// express-openapi-validator валідує ЗАПИТИ й ВІДПОВІДІ проти openapi/openapi.yaml,
// а error-handler перекладає будь-яку помилку у application/problem+json.
//
// Файл навмисно .cjs — щоб require(...) працював незалежно від "type" у package.json.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const OpenApiValidator = require('express-openapi-validator');

const app = express();
app.use(express.json());

const API_SPEC = path.join(__dirname, 'openapi', 'openapi.yaml');

// ---------------------------------------------------------------------------
// In-memory дані
// ---------------------------------------------------------------------------
const products = [
  { id: 'p_1', name: 'Mechanical Keyboard', price_cents: 2600, currency: 'UAH' },
  { id: 'p_2', name: 'Wireless Mouse', price_cents: 900, currency: 'UAH' },
  { id: 'p_3', name: 'USB-C Hub', price_cents: 1500, currency: 'UAH' },
];

const orders = [
  {
    id: 'o_1',
    status: 'created',
    items: [{ product_id: 'p_1', quantity: 1 }],
    total_cents: 2600,
    currency: 'UAH',
    created_at: '2026-08-01T09:00:00.000Z',
  },
  {
    id: 'o_2',
    status: 'paid',
    items: [{ product_id: 'p_2', quantity: 2 }],
    total_cents: 1800,
    currency: 'UAH',
    created_at: '2026-08-02T12:30:00.000Z',
  },
];

let orderSeq = orders.length;
// Idempotency-Key -> { hash, snapshot }
const idempotencyStore = new Map();

// ---------------------------------------------------------------------------
// Помилки як problem+json
// ---------------------------------------------------------------------------
class HttpProblem extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Cursor — непрозорий токен. Всередині — лише offset, base64url.
// ---------------------------------------------------------------------------
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const offset = Number(parsed.o);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('bad');
    return offset;
  } catch {
    throw new HttpProblem(400, "query parameter 'cursor' is not a valid opaque token");
  }
}

function paginate(collection, query) {
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  const offset = decodeCursor(query.cursor);
  const items = collection.slice(offset, offset + limit);
  const hasMore = offset + limit < collection.length;
  return { items, next_cursor: hasMore ? encodeCursor(offset + limit) : null };
}

// ---------------------------------------------------------------------------
// Роути
// ---------------------------------------------------------------------------
app.use(
  OpenApiValidator.middleware({
    apiSpec: API_SPEC,
    validateRequests: true,
    validateResponses: true, // саме це відхиляє відповідь, що суперечить спеці
  }),
);

app.get('/products', (req, res) => {
  res.json(paginate(products, req.query));
});

app.get('/products/:productId', (req, res, next) => {
  const product = products.find((p) => p.id === req.params.productId);
  if (!product) return next(new HttpProblem(404, `product not found: ${req.params.productId}`));
  res.json(product);
});

app.get('/orders', (req, res) => {
  res.json(paginate(orders, req.query));
});

app.get('/orders/:orderId', (req, res, next) => {
  const order = orders.find((o) => o.id === req.params.orderId);
  if (!order) return next(new HttpProblem(404, `order not found: ${req.params.orderId}`));
  res.json(order);
});

app.post('/orders', (req, res, next) => {
  // Валідатор уже гарантував: заголовок idempotency-key присутній, items >= 1.
  const key = req.headers['idempotency-key'];
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');

  // Ідемпотентність: той самий ключ...
  const seen = idempotencyStore.get(key);
  if (seen) {
    if (seen.hash === bodyHash) {
      // ...+ те саме тіло -> та сама відповідь (відтворення).
      res.set('Idempotency-Replay', 'true');
      return res.status(201).json(seen.snapshot);
    }
    // ...+ інше тіло -> конфлікт.
    return next(
      new HttpProblem(422, "Idempotency-Key was already used with a different request body"),
    );
  }

  // Рахуємо суму сервером, у цілих копійках.
  let total = 0;
  for (const item of req.body.items) {
    const product = products.find((p) => p.id === item.product_id);
    if (!product) return next(new HttpProblem(404, `product not found: ${item.product_id}`));
    total += product.price_cents * item.quantity;
  }

  const order = {
    id: `o_${++orderSeq}`,
    status: 'created',
    items: req.body.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
    total_cents: total,
    currency: req.body.currency || 'UAH',
    created_at: new Date().toISOString(),
  };
  orders.push(order);
  idempotencyStore.set(key, { hash: bodyHash, snapshot: order });

  res.status(201).json(order);
});

// ---------------------------------------------------------------------------
// Error-handler: будь-яка помилка -> application/problem+json (RFC 9457)
// ---------------------------------------------------------------------------
const TITLES = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const problem = {
    type: 'about:blank',
    title: TITLES[status] || 'Error',
    status,
    // err.message від express-openapi-validator уже читабельний, напр.:
    //   request/headers must have required property 'idempotency-key'
    //   request/body/items must NOT have fewer than 1 items
    detail: err.message || 'Unexpected error',
    instance: req.originalUrl,
  };
  res
    .status(status)
    .set('Content-Type', 'application/problem+json')
    .send(JSON.stringify(problem));
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Marketplace API (Variant Б) на http://localhost:${PORT}`);
  });
}

module.exports = app;
