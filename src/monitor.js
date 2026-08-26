import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const API_BASE = 'https://athena.eslite.com/api/v2/search';
const SEARCH_QUERIES = ['BEYBLADE X', 'BX', 'UX', 'CX', 'TAKARA TOMY', '戰鬥陀螺'];
const STATE_FILE = 'data/state.json';
const INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 30000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MODEL_RE = /\b(?:BX|UX|CX)[-－\s]?\d{2,3}\b/i;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

async function saveState(state) {
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function normalizeHits(json) {
  const candidates = [json?.hits?.hit, json?.hits, json?.data?.hits?.hit, json?.data?.hits,
    json?.data?.products, json?.data?.items, json?.products, json?.items,
    json?.result?.hits, json?.result?.products];
  for (const value of candidates) if (Array.isArray(value)) return value;
  return [];
}

function fieldValue(value) { return Array.isArray(value) ? value[0] : value; }

function normalizeProduct(hit) {
  const f = hit?.fields ?? hit?.document?.fields ?? hit?._source ?? hit?.source ?? hit ?? {};
  const id = String(fieldValue(hit?.id ?? hit?._id ?? f.id ?? f.product_id ?? f.productId) ?? '');
  const name = String(fieldValue(f.name ?? f.title ?? f.product_name ?? f.productName) ?? '').trim();
  const stockRaw = fieldValue(f.stock ?? f.stock_qty ?? f.stockQty);
  const stock = Number.parseInt(String(stockRaw ?? ''), 10);
  return {
    id, name,
    price: String(fieldValue(f.final_price ?? f.finalPrice ?? f.price) ?? ''),
    stock: Number.isFinite(stock) ? stock : null,
    status: String(fieldValue(f.status ?? f.sale_status ?? f.saleStatus) ?? ''),
    url: String(fieldValue(f.url ?? f.product_url ?? f.productUrl) ?? (id ? `https://www.eslite.com/product/${id}` : '')),
  };
}

function isTarget(product) { return Boolean(product.id && product.name && MODEL_RE.test(product.name)); }
function isBuyable(product) {
  return product.stock === null ? product.status === 'add_to_shopping_cart'
    : product.stock > 0 || product.status === 'add_to_shopping_cart';
}

function buildSearchUrl(query) {
  const url = new URL(API_BASE);
  url.searchParams.set('q', `"${query}"`);
  url.searchParams.set('final_price', '0,');
  url.searchParams.set('sort', 'weight');
  url.searchParams.set('size', '100');
  url.searchParams.set('start', '0');
  return url.toString();
}

async function fetchSearch(page, query) {
  const response = await page.goto(buildSearchUrl(query), {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  const status = response?.status() ?? 0;
  if (status !== 200) {
    const preview = (await page.locator('body').innerText().catch(() => '')).slice(0, 160);
    throw new Error(`HTTP ${status}${preview ? `: ${preview}` : ''}`);
  }
  const text = await page.locator('body').innerText();
  const json = JSON.parse(text);
  const hits = normalizeHits(json);
  console.log(`[SEARCH] "${query}" -> ${hits.length} hit(s)`);
  return hits;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(`[Telegram disabled] BOT_TOKEN=${Boolean(TELEGRAM_BOT_TOKEN)} CHAT_ID=${Boolean(TELEGRAM_CHAT_ID)}`);
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  console.log('[Telegram] notification sent');
}

function notification(type, product) {
  const title = type === 'NEW' ? '🚨 誠品發現新的戰鬥陀螺商品' : '🔥 誠品戰鬥陀螺補貨';
  return [title, '', product.name, product.price ? `售價：NT$${product.price}` : '',
    product.stock !== null ? `庫存：${product.stock}` : '', product.status ? `狀態：${product.status}` : '',
    '', product.url].filter(Boolean).join('\n');
}

async function checkOnce(page) {
  console.log(`\n[${new Date().toISOString()}] Checking Eslite Athena API...`);
  const allHits = [];
  let successfulSearches = 0;

  for (const query of SEARCH_QUERIES) {
    try {
      allHits.push(...await fetchSearch(page, query));
      successfulSearches++;
    } catch (error) {
      console.error(`[SEARCH ERROR] ${query}: ${error.message}`);
    }
  }

  if (successfulSearches === 0) {
    throw new Error('All Eslite searches failed; state was not changed.');
  }

  const byId = new Map();
  for (const hit of allHits) {
    const product = normalizeProduct(hit);
    if (product.id) byId.set(product.id, product);
  }

  const normalized = [...byId.values()];
  const products = normalized.filter(isTarget);
  console.log(`Unique products across searches: ${normalized.length}`);
  console.log(`Found ${products.length} BX/UX/CX target product(s).`);
  products.forEach(p => console.log(`[TARGET] ${p.id} ${p.name} stock=${p.stock} status=${p.status}`));

  const previous = await loadState();
  const next = { ...previous };

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
  console.log(`Check finished. Next check in ${Math.round(INTERVAL_MS / 1000)} seconds.`);
}

async function main() {
  console.log(`Starting local Eslite monitor. Interval=${INTERVAL_MS}ms`);
  console.log('Launching installed Google Chrome via Playwright...');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  let stopping = false;
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received. Closing Chrome...`);
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  while (!stopping) {
    const started = Date.now();
    try {
      await checkOnce(page);
    } catch (error) {
      console.error(`[CHECK ERROR] ${error.message}`);
    }
    const wait = Math.max(1000, INTERVAL_MS - (Date.now() - started));
    await sleep(wait);
  }
}

main().catch(error => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
