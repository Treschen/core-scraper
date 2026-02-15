import "dotenv/config";
import { chromium } from "playwright";

import { loginIfNeeded } from "./lib/login.mjs";
import { extractProduct } from "./lib/extract-product.mjs";
import { postJsonWithRetry } from "./lib/fetch-retry.mjs";
import { buildCanonicalItem } from "./lib/normalize.mjs";

const {
  SUPPLIER_BASE,
  DEALER_EMAIL,
  DEALER_PASSWORD,
  PRODUCT_URL,
  N8N_WEBHOOK_URL,
  DRY_RUN = "false",
} = process.env;

if (!SUPPLIER_BASE) throw new Error("Missing env SUPPLIER_BASE");
if (!PRODUCT_URL) throw new Error("Missing env PRODUCT_URL");
if (!N8N_WEBHOOK_URL && DRY_RUN !== "true") {
  throw new Error("Missing env N8N_WEBHOOK_URL");
}

// --- Vendor normaliser for Core (Apple / DJI / Nintendo / Microsoft / Accessories) ----
function normaliseVendorForCore(prod) {
  const title = (prod.title || "").trim();
  const sku = (prod.sku || "").trim();
  let vendor = (prod.vendor || "").trim();

  const t = title.toLowerCase();
  const s = sku.toLowerCase();

  // Strong brand keyword checks
  const hasApple = t.includes("apple") || t.includes("macbook") || t.includes("imac") || t.includes("ipad") || t.includes("iphone") || t.includes("airpods") || t.includes("watch");
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
  const isAppleSku = /^[a-z0-9]{5,6}$/i.test(sku) || s.startsWith("mq") || s.startsWith("mn") || s.startsWith("my"); // Apple retail SKU patterns are often short

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

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1) Login
  await loginIfNeeded(page, {
    base: SUPPLIER_BASE,
    email: DEALER_EMAIL,
    password: DEALER_PASSWORD,
  });

  // 2) Go to the target product
  console.log("[single] navigating:", PRODUCT_URL);
  await page.goto(PRODUCT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  // 3) Extract raw product data from the page
  const raw = await extractProduct(page);

  // 4) Normalise vendor (JK / Epson / Dtech) and ensure URL present
  const enriched = normaliseVendorForCore({
    ...raw,
    url: raw.url || PRODUCT_URL,
  });

  // 5) Build canonical item for ingest
  const item = buildCanonicalItem(enriched);

  console.log("[single] canonical item:", JSON.stringify(item, null, 2));

  if (DRY_RUN === "true") {
    console.log("[DRY_RUN] Skipping POST to n8n.");
    await browser.close();
    return;
  }

  // 6) Wrap in payload and POST to n8n
  const payload = {
    source: "core",
    crawledAt: new Date().toISOString(),
    count: 1,
    items: [item],
  };

  console.log("→ Posting to n8n:", N8N_WEBHOOK_URL);
  await postJsonWithRetry(N8N_WEBHOOK_URL, payload, {
    retries: 5,
    baseDelayMs: 500,
  });
  console.log("✔ posted:", item.title || item.sku, "@", item.price);

  await browser.close();
}

main().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(2);
});
