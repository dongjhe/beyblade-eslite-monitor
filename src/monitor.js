import fs from 'node:fs/promises';

const API_URL = 'https://athena.eslite.com/api/v2/search?q=%22BEYBLADE+X%22&final_price=0,&sort=weight&size=100&start=0';
const STATE_FILE = 'data/state.json';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MODEL_RE = /\b(?:BX|UX|CX)[-－\s]?\d{2,3}\b/i;

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

async function saveState(state) {
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// Athena has returned more than one response shape over time.
function normalizeHits(json) {
  const candidates = [
    json?.hits?.hit,
    json?.hits,
    json?.data?.hits?.hit,
    json?.data?.hits,
    json?.data?.products,
    json?.data?.items,
    json?.products,
    json?.items,
    json?.result?.hits,
    json?.result?.products,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function fieldValue(value) {
  // Some search engines return fields as one-element arrays.
  return Array.isArray(value) ? value[0] : value;
}

function normalizeProduct(hit) {
  const f = hit?.fields ?? hit?.document?.fields ?? hit?._source ?? hit?.source ?? hit ?? {};
  const id = String(fieldValue(hit?.id ?? hit?._id ?? f.id ?? f.product_id ?? f.productId) ?? '');
  const name = String(fieldValue(f.name ?? f.title ?? f.product_name ?? f.productName) ?? '').trim();
  const stockRaw = fieldValue(f.stock ?? f.stock_qty ?? f.stockQty);
  const stock = Number.parseInt(String(stockRaw ?? ''), 10);

  return {
    id,
    name,
    price: String(fieldValue(f.final_price ?? f.finalPrice ?? f.price) ?? ''),
    stock: Number.isFinite(stock) ? stock : null,
    status: String(fieldValue(f.status ?? f.sale_status ?? f.saleStatus) ?? ''),
    url: String(fieldValue(f.url ?? f.product_url ?? f.productUrl) ?? (id ? `https://www.eslite.com/product/${id}` : '')),
  };
}

function isTarget(product) {
  return Boolean(product.id && product.name && MODEL_RE.test(product.name));
}

function isBuyable(product) {
  return product.stock === null
    ? product.status === 'add_to_shopping_cart'
    : product.stock > 0 || product.status === 'add_to_shopping_cart';
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(`[Telegram disabled] BOT_TOKEN=${Boolean(TELEGRAM_BOT_TOKEN)} CHAT_ID=${Boolean(TELEGRAM_CHAT_ID)}`);
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });

  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
  console.log('[Telegram] notification sent');
}

function notification(type, product) {
  const title = type === 'NEW' ? '🚨 誠品發現新的戰鬥陀螺商品' : '🔥 誠品戰鬥陀螺補貨';
  return [title, '', product.name,
    product.price ? `售價：NT$${product.price}` : '',
    product.stock !== null ? `庫存：${product.stock}` : '',
    product.status ? `狀態：${product.status}` : '', '', product.url]
    .filter(Boolean).join('\n');
}

async function main() {
  console.log(`[${new Date().toISOString()}] Checking Eslite Athena API...`);

  const response = await fetch(API_URL, {
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      referer: 'https://www.eslite.com/',
      origin: 'https://www.eslite.com',
    },
  });

  console.log(`Eslite HTTP ${response.status} content-type=${response.headers.get('content-type')}`);
  if (!response.ok) throw new Error(`Eslite API HTTP ${response.status}: ${await response.text()}`);

  const json = await response.json();
  const hits = normalizeHits(json);
  console.log(`Athena top-level keys: ${Object.keys(json).join(', ')}`);
  console.log(`Raw search hits: ${hits.length}`);

  if (hits.length === 0) {
    console.log('Athena response preview:', JSON.stringify(json).slice(0, 3000));
  }

  const normalized = hits.map(normalizeProduct);
  normalized.slice(0, 10).forEach((p, i) => console.log(`[RAW ${i + 1}] id=${p.id} name=${p.name} stock=${p.stock} status=${p.status}`));

  const products = normalized.filter(isTarget);
  const previous = await loadState();
  const next = {};
  console.log(`Found ${products.length} target product(s).`);

  for (const product of products) {
    const old = previous[product.id];
    next[product.id] = product;

    if (!old) {
      console.log(`[NEW] ${product.name} stock=${product.stock}`);
      await sendTelegram(notification('NEW', product));
      continue;
    }

    if (!isBuyable(old) && isBuyable(product)) {
      console.log(`[RESTOCK] ${product.name} ${old.stock} -> ${product.stock}`);
      await sendTelegram(notification('RESTOCK', product));
    }
  }

  await saveState(next);
  console.log('Monitor finished.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
