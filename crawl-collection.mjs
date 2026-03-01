import "dotenv/config";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromium.use(StealthPlugin());
import pLimit from "p-limit";

import { loginIfNeeded } from "./lib/login.mjs";
import { extractProduct } from "./lib/extract-product.mjs";
import {
  getProductLinksOnPage,
  getNextPageUrl,
  setItemsPerPageToMax
} from "./lib/pagination.mjs";
import { postJsonWithRetry } from "./lib/fetch-retry.mjs";

const {
  SUPPLIER_BASE,
  DEALER_EMAIL,
  DEALER_PASSWORD,
  COLLECTION_URL,
  COLLECTION_URLS,
  N8N_WEBHOOK_URL,
  MAX_PAGES = "10",
  CONCURRENCY = "10",
  BATCH_SIZE = "50",
  DRY_RUN = "false",
} = process.env;

const startUrls = (COLLECTION_URLS || COLLECTION_URL || "")
  .split(",")
  .map(u => u.trim())
  .filter(Boolean);

if (!startUrls.length) {
  throw new Error("Missing env: COLLECTION_URL or COLLECTION_URLS");
}
if (!N8N_WEBHOOK_URL && DRY_RUN !== "true") {
  throw new Error("Missing env: N8N_WEBHOOK_URL");
}

const maxPages = parseInt(MAX_PAGES, 10);
const limit = pLimit(parseInt(CONCURRENCY, 10));
const batchSize = Math.max(1, parseInt(BATCH_SIZE, 10) || 50);

// util: make a stable key (sku preferred, else handle)
function makeKey(item) {
  const url = item.url || "";
  const handle = (url.match(/\/products\/([^/?#]+)/i) || [])[1] || "";
  return handle; // ALWAYS use handle — ignore SKU for dedupe
}

// util: dedupe by key (last write wins)
function dedupeByKey(items) {
  const m = new Map();
  for (const it of items) m.set(makeKey(it), it);
  return Array.from(m.values());
}

// util: chunk an array
function chunk(arr, n) {
  if (arr.length <= n) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// --- Vendor normaliser for Core (Apple / DJI / Nintendo / Microsoft / Accessories) ----
function normaliseVendorForCore(prod) {
  const title = (prod.title || "").trim();
  const sku = (prod.sku || "").trim();
  let vendor = (prod.vendor || "").trim();

  const t = title.toLowerCase();
  const s = sku.toLowerCase();

  // Strong brand keyword checks
  const hasApple =
    t.includes("apple") ||
    t.includes("macbook") ||
    t.includes("imac") ||
    t.includes("ipad") ||
    t.includes("iphone") ||
    t.includes("airpods") ||
    t.includes("watch");
  const hasDJI = t.includes("dji") || t.includes("mavic") || t.includes("osmo") || t.includes("ronin");
  const hasNintendo = t.includes("nintendo") || t.includes("switch") || t.includes("joy-con") || t.includes("joycon");
  const hasMicrosoft = t.includes("microsoft") || t.includes("surface");
  const hasBelkin = t.includes("belkin");
  const hasOtterbox = t.includes("otterbox") || t.includes("otter box");
  const hasLogitech = t.includes("logitech");
  const hasJBL = t.includes("jbl");
  const hasAnker = t.includes("anker");
  const hasSatechi = t.includes("satechi");

  // Some lightweight SKU heuristics (optional)
  const isNintendoSku = s.startsWith("n") && (s.includes("switch") || s.includes("ns") || s.includes("hac")); // loose
  const isDJISku = s.startsWith("dji");
  const isMicrosoftSku = s.startsWith("surface") || s.startsWith("microsoft");
  const isAppleSku = /^[a-z0-9]{5,6}$/i.test(sku) || s.startsWith("mq") || s.startsWith("mn") || s.startsWith("my");

  if (hasDJI || isDJISku) vendor = "DJI";
  else if (hasNintendo || isNintendoSku) vendor = "Nintendo";
  else if (hasMicrosoft || isMicrosoftSku) vendor = "Microsoft";
  else if (hasApple || isAppleSku) vendor = "Apple";
  else if (hasBelkin) vendor = "Belkin";
  else if (hasOtterbox) vendor = "Otterbox";
  else if (hasLogitech) vendor = "Logitech";
  else if (hasJBL) vendor = "JBL";
  else if (hasAnker) vendor = "Anker";
  else if (hasSatechi) vendor = "Satechi";

  return { ...prod, vendor };
}

async function sendBatchesForCollection(items, collectionIndex, collectionUrl) {
  if (!items.length) {
    console.log(
      `[collection ${collectionIndex + 1}] no items to send, skipping webhook.`
    );
    return;
  }

  const deduped = dedupeByKey(items);
  console.log(
    `\n[collection ${collectionIndex + 1}] preparing to send ${deduped.length} items (${items.length} raw) for ${collectionUrl}`
  );

  if (DRY_RUN === "true") {
    console.log(
      `[DRY_RUN] Would POST ${deduped.length} items in batches of ${batchSize} for collection ${collectionIndex + 1} to ${N8N_WEBHOOK_URL || "(no URL)"}`
    );
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

    console.log(
      `[collection ${collectionIndex + 1}] posting batch ${i + 1}/${batches.length} (${part.length} items) to N8N: ${N8N_WEBHOOK_URL}`
    );

    await postJsonWithRetry(N8N_WEBHOOK_URL, body, {
      retries: 5,
      baseDelayMs: 500,
    });
  }
}

// Core collections often hydrate the grid after DOMContentLoaded.
// This helper waits for product anchors and triggers lazy-load/hydration.
async function ensureCollectionHydrated(page, { isFirstPage } = { isFirstPage: false }) {
  // Give SPA/hydration a chance (don’t fail if it never reaches networkidle)
  await page.waitForLoadState("networkidle").catch(() => {});

  // On some Core pages, the /products/ anchors appear only after hydration.
  await page.waitForSelector('a[href*="/products/"]', { timeout: 20000 }).catch(() => {});

  // Kick lazy-load / grid render by scrolling
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(900);
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(400);

  // If first page and items-per-page dropdown exists, set it, then re-hydrate
  if (isFirstPage) {
    await setItemsPerPageToMax(page).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForSelector('a[href*="/products/"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function main() {
  console.log(`[init] startUrls (${startUrls.length}):`);
  startUrls.forEach(u => console.log(`  - ${u}`));

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  await ctx.addInitScript(() => {
    // Hide automation flags
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // Fake Chrome runtime (missing in headless)
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    // Fake plugins array (headless has 0, real Chrome has some)
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    // Languages
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  const page = await ctx.newPage();

  await loginIfNeeded(page, {
    base: SUPPLIER_BASE,
    email: DEALER_EMAIL,
    password: DEALER_PASSWORD,
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

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });

      // ✅ Core fix: wait for hydration + scroll kick + optional items-per-page on page 1
      await ensureCollectionHydrated(page, { isFirstPage: pages === 1 });

      const links = await getProductLinksOnPage(page);
      console.log(
        `[collection ${idx + 1}] page ${pages}: found ${links.length} links`
      );

      await Promise.all(
        links.map(href =>
          limit(async () => {
            const p = await ctx.newPage();
            try {
              await p.goto(href, {
                waitUntil: "domcontentloaded",
                timeout: 120000,
              });

              // Product pages can also hydrate after DOMContentLoaded
              await p.waitForLoadState("networkidle").catch(() => {});
              await p.waitForTimeout(200);

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
                // duplicate key, skipping
              } else {
                globalSeenKeys.add(key);
                collectedForSet.push(full);
                totalItems++;
                console.log(`  ✔ scraped: ${prod.title}`);
              }
            } catch (e) {
              console.error(`  ✖ scrape failed ${href}:`, e.message);
              await p.screenshot({
                path: `error-${Date.now()}.png`,
                fullPage: true,
              }).catch(() => {});
            } finally {
              await p.close();
            }
          })
        )
      );

      // Find next page (supports hidden infinite-scroll)
      const nextUrl = await getNextPageUrl(page);
      if (!nextUrl) {
        console.log(
          `[collection ${idx + 1}] no further page link/data-href found; stopping pagination.`
        );
      }
      url = nextUrl;
    }

    console.log(
      `[collection ${idx + 1}] finished pagination. Pages: ${pages}, collected items: ${collectedForSet.length}`
    );

    await sendBatchesForCollection(collectedForSet, idx, startUrl);
  }

  console.log(
    `Done. Collections: ${startUrls.length}, Pages: ${totalPages}, Products scraped (unique keys): ${totalItems}`
  );

  await browser.close();
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(2);
});