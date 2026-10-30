import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const PAGE_URL = 'https://www.eslite.com/exhibitions/CU202310-00113#sidebar-4-1';
const STATE_FILE = 'data/exhibition-strengthening-state.json';
const INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 30000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function saveState(products) {
  await fs.mkdir('data', { recursive: true });
  const temp = STATE_FILE + '.tmp';
  await fs.writeFile(temp, JSON.stringify({ products, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  await fs.rename(temp, STATE_FILE);
}

async function collectProducts(page) {
  const response = await page.goto(PAGE_URL.split('#')[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (response?.status() !== 200) throw new Error('Exhibition HTTP ' + response?.status());
  // The hash is a navigation anchor, not a server-side filter.
  // Locate the actual section heading; never scan all product cards on the page.
  await page.waitForFunction(() => {
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    return headings.some(h => /BEYBLADE\s*X.*強化組/i.test(h.textContent || ''));
  }, { timeout: 15000 }).catch(() => {});
  const result = await page.evaluate(() => {
    const heading = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .find(h => /BEYBLADE\s*X.*強化組/i.test(h.textContent || ''));
    if (!heading) return { error: 'Strengthening section heading not found' };
    const level = Number(heading.tagName.slice(1));
    const items = new Map();
    // Traverse forward until the next heading at the same or higher level.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = heading;
    let node;
    while ((node = walker.nextNode())) {
      if (/^H[1-6]$/.test(node.tagName) && Number(node.tagName.slice(1)) <= level) break;
      if (node.tagName !== 'A') continue;
      const href = node.getAttribute('href') || '';
      const match = href.match(/\/product\/(\d+)/);
      if (!match) continue;
      const card = node.closest('article,li,[class*="product"],[class*="card"]') || node;
      const name = (node.getAttribute('title') || node.getAttribute('aria-label') ||
        card.querySelector('h3,h4,[class*="name"],[class*="title"]')?.textContent ||
        node.textContent || node.querySelector('img')?.alt || '').trim().replace(/\s+/g, ' ');
      items.set(match[1], { id: match[1], name: name || 'BEYBLADE X 商品', url: new URL(href, location.origin).href });
    }
    return { products: [...items.values()] };
  });
  if (result.error) throw new Error(result.error);
  if (!result.products?.length) throw new Error('No products found in strengthening section; preserving state');
  return result.products;
}

async function sendTelegram(product) {
  const text = ['🚨 誠品 BEYBLADE X 強化組新增商品！', '', '🎯 ' + product.name, '', '🛒 ' + product.url].join('\n');
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[TELEGRAM] Missing BOT_TOKEN or CHAT_ID; no notification sent');
    return false;
  }
  const response = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error('Telegram HTTP ' + response.status);
  return true;
}

async function checkOnce(page) {
  const products = await collectProducts(page);
  console.log('[CHECK]', new Date().toISOString(), 'Strengthening products:', products.length);
  const state = await loadState();
  if (!state) {
    await saveState(products);
    console.log('[BASELINE] Initial products saved; no notifications.');
    return;
  }
  const known = new Set((state.products || []).map(p => p.id));
  const next = [...state.products || []];
  for (const product of products) {
    if (known.has(product.id)) continue;
    console.log('[NEW]', product.id, product.name);
    if (!await sendTelegram(product)) {
      console.warn('[NEW] Notification not delivered; keeping item pending.');
      continue;
    }
    known.add(product.id);
    next.push(product);
    await saveState(next);
  }
  // Keep historical IDs so temporary removals/reordering never cause repeat alerts.
  console.log('[DONE] Next check in', INTERVAL_MS / 1000, 'seconds');
}

function isBrowserClosedError(error) {
  const msg = String(error?.message || error).toLowerCase();
  return ['browser has been closed', 'target closed', 'page has been closed',
    'context has been closed', 'target page, context or browser has been closed']
    .some(s => msg.includes(s));
}
async function createSession() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  browser.on('disconnected', () => console.error('[BROWSER] Disconnected; restarting.'));
  return { browser, context, page };
}
async function closeSession(s) {
  if (!s) return;
  await s.page?.close().catch(() => {});
  await s.context?.close().catch(() => {});
  await s.browser?.close().catch(() => {});
}
const alive = s => Boolean(s?.browser?.isConnected() && s?.page && !s.page.isClosed());

async function main() {
  if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS < 1000) throw new Error('Invalid CHECK_INTERVAL_MS');
  console.log('[START] Eslite strengthening section monitor; interval:', INTERVAL_MS);
  let session = null, stopping = false;
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    console.log('[STOP]', signal);
    await closeSession(session);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  while (!stopping) {
    const start = Date.now();
    try {
      if (!alive(session)) {
        await closeSession(session);
        session = await createSession();
      }
      await checkOnce(session.page);
    } catch (error) {
      console.error('[CHECK ERROR]', error.message);
      if (isBrowserClosedError(error) || !alive(session)) {
        await closeSession(session);
        session = null;
      }
    }
    await sleep(Math.max(1000, INTERVAL_MS - (Date.now() - start)));
  }
}
main().catch(e => { console.error('[FATAL]', e); process.exitCode = 1; });
