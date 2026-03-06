import "dotenv/config";
import fs from "node:fs";
import { chromium } from "playwright";
import pLimit from "p-limit";

import { loginIfNeeded } from "./lib/login.mjs";
import { extractProduct } from "./lib/extract-product.mjs";
import { getProductLinksOnPage, getNextPageUrl } from "./lib/pagination.mjs";
import { postJsonWithRetry } from "./lib/fetch-retry.mjs";

const {
  SUPPLIER_BASE = "https://core.co.za",
  DEALER_EMAIL = "",
  DEALER_PASSWORD = "",
  COLLECTION_URL,
  COLLECTION_URLS,
  N8N_WEBHOOK_URL,
  MAX_PAGES = "10",
  CONCURRENCY = "5",
  BATCH_SIZE = "50",
  DRY_RUN = "false",
} = process.env;

const startUrls = (COLLECTION_URLS || COLLECTION_URL || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

if (!startUrls.length) throw new Error("Missing env: COLLECTION_URL or COLLECTION_URLS");
if (!N8N_WEBHOOK_URL && DRY_RUN !== "true") throw new Error("Missing env: N8N_WEBHOOK_URL");

const maxPages = parseInt(MAX_PAGES, 10);
const limit = pLimit(parseInt(CONCURRENCY, 10));
const batchSize = Math.max(1, parseInt(BATCH_SIZE, 10) || 50);

const AUTH_STATE_PATH = "/app/.auth/state.json";

// util: make a stable key (sku preferred, else handle)
function makeKey(item) {
  const url = item.url || "";
  const handle = (url.match(/\/products\/([^/?#]+)/i) || [])[1] || "";
  return (item.sku || "").trim() || handle;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out.length ? out : [arr];
}

function dedupeByKey(items) {
  const m = new Map();
  for (const it of items) m.set(makeKey(it), it);
  return Array.from(m.values());
}

// Core vendor normaliser
function normaliseVendorForCore(prod) {
  const title = (prod.title || "").trim();
  const sku = (prod.sku || "").trim();
  let vendor = (prod.vendor || "").trim();

  const t = title.toLowerCase();
  const s = sku.toLowerCase();

  const hasApple =
    t.includes("apple") || t.includes("macbook") || t.includes("imac") || t.includes("ipad") ||
    t.includes("iphone") || t.includes("airpods") || t.includes("watch");

  const hasDJI = t.includes("dji") || t.includes("mavic") || t.includes("osmo") || t.includes("ronin");
  const hasNintendo = t.includes("nintendo") || t.includes("switch") || t.includes("joy-con") || t.includes("joycon");
  const hasMicrosoft = t.includes("microsoft") || t.includes("surface");

  const hasBelkin = t.includes("belkin");
  const hasOtterbox = t.includes("otterbox") || t.includes("otter box");
  const hasLogitech = t.includes("logitech");
  const hasAnker = t.includes("anker");
  const hasSatechi = t.includes("satechi");
  const hasJBL = t.includes("jbl");

  const isDJISku = s.startsWith("dji");
  const isAppleSku = s.startsWith("mq") || s.startsWith("mn") || s.startsWith("my");
  const isMicrosoftSku = s.startsWith("surface") || s.startsWith("microsoft");

  if (hasDJI || isDJISku) vendor = "DJI";
  else if (hasNintendo) vendor = "Nintendo";
  else if (hasMicrosoft || isMicrosoftSku) vendor = "Microsoft";
  else if (hasApple || isAppleSku) vendor = "Apple";
  else if (hasBelkin) vendor = "Belkin";
  else if (hasOtterbox) vendor = "Otterbox";
  else if (hasLogitech) vendor = "Logitech";
  else if (hasAnker) vendor = "Anker";
  else if (hasSatechi) vendor = "Satechi";
  else if (hasJBL) vendor = "JBL";

  return { ...prod, vendor };
}

// Core collection pages often hydrate after DOMContentLoaded.
// This forces product tiles to render before link extraction.
async function ensureCollectionHydrated(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForSelector('a[href*="/products/"], [data-product-url], [data-href], [data-url]', { timeout: 20000 }).catch(() => {});
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(900);
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(300);
}

async function sendBatchesForCollection(items, collectionIndex, collectionUrl) {
  if (!items.length) {
    console.log(`[collection ${collectionIndex + 1}] no items to send, skipping webhook.`);
    return;
  }

  const deduped = dedupeByKey(items);
  console.log(`\n[collection ${collectionIndex + 1}] preparing to send ${deduped.length} items (${items.length} raw) for ${collectionUrl}`);

  if (DRY_RUN === "true") {
    console.log(`[DRY_RUN] Would POST ${deduped.length} items in batches of ${batchSize} to ${N8N_WEBHOOK_URL || "(no URL)"}`);
    return;
  }

  const batches = chunk(deduped, batchSize);
  for (let i = 0; i < batches.length; i++) {
    const part = batches[i];
    const body = {
      source: "core",
      collectionIndex,
      collectionUrl,
      batchIndex: i,
      batchCount: batches.length,
      count: part.length,
      items: part,
    };

    console.log(`[collection ${collectionIndex + 1}] posting batch ${i + 1}/${batches.length} (${part.length} items) to N8N: ${N8N_WEBHOOK_URL}`);

    await postJsonWithRetry(N8N_WEBHOOK_URL, body, { retries: 5, baseDelayMs: 500 });
  }
}

async function main() {
  console.log(`[init] startUrls (${startUrls.length}):`);
  startUrls.forEach((u) => console.log(`  - ${u}`));

  const browser = await chromium.launch({ headless: true });

  const ctx = await browser.newContext(
    fs.existsSync(AUTH_STATE_PATH) ? { storageState: AUTH_STATE_PATH } : {}
  );

  if (fs.existsSync(AUTH_STATE_PATH)) {
    console.log(`[auth] loaded storageState: ${AUTH_STATE_PATH}`);
  } else {
    console.log(`[auth] no storageState found at ${AUTH_STATE_PATH}`);
  }

  const page = await ctx.newPage();

  await loginIfNeeded(page, {
    base: SUPPLIER_BASE,
    email: DEALER_EMAIL,
    password: DEALER_PASSWORD,
    authStatePath: AUTH_STATE_PATH,
  });

  let totalPages = 0;
  let totalItems = 0;
  const globalSeenKeys = new Set();

  for (let idx = 0; idx < startUrls.length; idx++) {
    const startUrl = startUrls[idx];
    console.log(`\n[set ${idx + 1}/${startUrls.length}] starting at ${startUrl}`);

    let url = startUrl;
    let pages = 0;
    const collectedForSet = [];

    while (url && pages < maxPages) {
      pages++;
      totalPages++;
      console.log(`[collection ${idx + 1}] page ${pages}: ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

      await page.waitForTimeout(2500).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await ensureCollectionHydrated(page);

      const links = await getProductLinksOnPage(page);
      console.log(`[collection ${idx + 1}] page ${pages}: found ${links.length} links`);
      links.slice(0, 10).forEach((l) => console.log(`  - ${l}`));

      await Promise.all(
        links.map((href) =>
          limit(async () => {
            const p = await ctx.newPage();
            try {
              await p.goto(href, { waitUntil: "domcontentloaded", timeout: 120000 });
              await p.waitForLoadState("networkidle").catch(() => {});
              await p.waitForTimeout(150);

              const prodRaw = await extractProduct(p);
              const prod = normaliseVendorForCore(prodRaw);

              const full = {
                source: "core",
                crawledAt: new Date().toISOString(),
                collectionIndex: idx,
                collectionUrl: startUrl,
                ...prod,
              };

              const key = makeKey(full);
              if (globalSeenKeys.has(key)) {
                // quiet skip
              } else {
                globalSeenKeys.add(key);
                collectedForSet.push(full);
                totalItems++;
                console.log(`  ✔ scraped: ${prod.title}`);
              }
            } catch (e) {
              console.error(`  ✖ scrape failed ${href}:`, e.message);
              await p.screenshot({ path: `error-${Date.now()}.png`, fullPage: true }).catch(() => {});
            } finally {
              await p.close();
            }
          })
        )
      );

      const nextUrl = await getNextPageUrl(page, links.length);
      if (!nextUrl) console.log(`[collection ${idx + 1}] no further page link/data-href found; stopping pagination.`);
      url = nextUrl;
    }

    console.log(`[collection ${idx + 1}] finished pagination. Pages: ${pages}, collected items: ${collectedForSet.length}`);
    await sendBatchesForCollection(collectedForSet, idx, startUrl);
  }

  console.log(`Done. Collections: ${startUrls.length}, Pages: ${totalPages}, Products scraped (unique keys): ${totalItems}`);
  await browser.close();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});