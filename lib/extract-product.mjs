// lib/extract-product.mjs
import { parsePrice, modelFrom, canonicalHandle } from "./normalize.mjs";

/** try to get product JSON from Shopify's public endpoint */
async function fetchShopifyProductJson(page) {
  try {
    const url = new URL(page.url());
    const handle = canonicalHandle(url.href);
    if (!handle) return null;

    const apiUrl = `${url.origin}/products/${handle}.js`;
    // Run in page context to avoid CORS headaches
    const data = await page.evaluate(async (endpoint) => {
      try {
        const r = await fetch(endpoint, { credentials: "omit", cache: "no-store" });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    }, apiUrl);

    return data || null;
  } catch {
    return null;
  }
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function isBadTitle(t) {
  const x = cleanText(t).toLowerCase();
  return !x || x === "search" || x === "customer login" || x === "account" || x === "login";
}

export async function extractProduct(page) {
  const url = page.url();

  // 🔹 Fetch Shopify product JSON once up front
  const pj = await fetchShopifyProductJson(page);

  // --- TITLE (prefer product.js) ---
  let title = "";
  if (pj?.title && !isBadTitle(pj.title)) {
    title = cleanText(pj.title);
  }

  // Fallbacks (scoped to main/product content, NOT global h1)
  if (!title) {
    // Try OG title first (often correct on Shopify)
    const ogTitle = await page
      .locator('meta[property="og:title"]')
      .first()
      .getAttribute("content")
      .catch(() => "");
    if (!isBadTitle(ogTitle)) title = cleanText(ogTitle);
  }

  if (!title) {
    // Product-area heading selectors
    const domTitle =
      cleanText(
        await page
          .locator(
            "main .product__title, main h1.product__title, main h1.product-title, main [itemprop='name'], main h1"
          )
          .first()
          .textContent()
          .catch(() => "")
      ) || "";

    if (!isBadTitle(domTitle)) title = domTitle;
  }

  // Last resort: page title (still better than 'Search')
  if (!title) {
    const pt = cleanText(await page.title().catch(() => ""));
    if (!isBadTitle(pt)) title = pt;
  }

  // --- VENDOR (prefer product.js) ---
  let vendor = "";
  if (pj?.vendor) vendor = cleanText(pj.vendor);

  if (!vendor) {
    vendor =
      cleanText(
        await page
          .locator(".product-vendor, a.vendor, .product__vendor, [itemprop='brand']")
          .first()
          .textContent()
          .catch(() => "")
      ) || "";
  }

  // --- PRICE (meta/DOM first, then product.js) ---
  let priceText =
    (await page
      .locator('[itemprop="price"]')
      .first()
      .getAttribute("content")
      .catch(() => null)) ||
    (await page
      .locator('meta[itemprop="price"]')
      .first()
      .getAttribute("content")
      .catch(() => null)) ||
    cleanText(
      await page
        .locator("[data-product-price], .price .money, .product__price, .price")
        .first()
        .textContent()
        .catch(() => "")
    ) ||
    "";

  let price = parsePrice(priceText);

  // Prefer product.js price if DOM fails (Shopify .js returns cents)
  if ((!price || price === 0) && pj?.variants?.length) {
    const v = pj.variants.find((x) => x.available) || pj.variants[0];
    if (v && typeof v.price === "number") price = v.price / 100;
  }

  // --- SKU (DOM → fallback to product.js) ---
  let sku =
    cleanText(
      await page
        .locator('[itemprop="sku"], .product-sku, .sku, .product__sku')
        .first()
        .textContent()
        .catch(() => "")
    ) || "";

  if (!sku && pj?.variants?.length) {
    const v = pj.variants.find((x) => x.available) || pj.variants[0];
    if (v?.sku) sku = cleanText(String(v.sku));
  }

  // Final fallback for SKU from title pattern
  if (!sku) sku = modelFrom(title);

  // --- AVAILABILITY (prefer product.js) ---
  let availability =
    cleanText(
      await page
        .locator("[data-availability], .product-stock, .availability, link[itemprop='availability']")
        .first()
        .textContent()
        .catch(() => "")
    ) || "";

  if (pj?.variants?.length) {
    const anyAvailable = pj.variants.some((v) => v.available);
    availability = anyAvailable ? "InStock" : "OutOfStock";
  }

  if (!availability) availability = "InStock";

  // --- IMAGE (DOM → fallback to product.js) ---
  let image =
    (await page
      .locator('.product__media img, img[src*="/cdn/"], .product-gallery img')
      .first()
      .getAttribute("src")
      .catch(() => null)) || null;

  if (image && !/^https?:\/\//i.test(image)) {
    try {
      image = new URL(image, url).href;
    } catch {
      /* noop */
    }
  }

  if (!image && pj?.images?.length) image = pj.images[0];

  // Optional description HTML
  const descriptionHtml =
    (await page
      .locator(".product__description, [itemprop='description'], .rte")
      .first()
      .innerHTML()
      .catch(() => "")) || "";
// --- FINAL PRICE ROUNDING (fix floating point issues) ---
if (typeof price === "number" && Number.isFinite(price)) {
  price = Math.round(price * 100) / 100;
}

  return {
    title,
    vendor,
    sku,
    price, // Number (in R), not cents
    currency: "ZAR",
    availability,
    images: image ? [image] : [],
    url,
    descriptionHtml,
  };
}