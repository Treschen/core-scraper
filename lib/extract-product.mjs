// lib/extract-product.mjs
import { parsePrice, modelFrom, canonicalHandle } from "./normalize.mjs";

/** try to get product JSON from Shopify's public endpoint */
async function fetchShopifyProductJson(page) {
  try {
    const url = new URL(page.url());
    const handle = canonicalHandle(url.href);
    if (!handle) return null;

    const apiUrl = `${url.origin}/products/${handle}.js`;

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

async function extractStockQuantity(page, pj) {
  // 1) DOM text like "59 items left"
  const bodyText = await page.locator("body").textContent().catch(() => "") || "";
  const m1 = bodyText.match(/\b(\d+)\s+items?\s+left\b/i);
  if (m1) return parseInt(m1[1], 10);

  // 2) More targeted locator scan
  const candidateTexts = await page.locator("span, div, p, small").allTextContents().catch(() => []);
  for (const t of candidateTexts) {
    const m = String(t).match(/\b(\d+)\s+items?\s+left\b/i);
    if (m) return parseInt(m[1], 10);
  }

  // 3) Shopify product.js variant quantity if available
  if (pj?.variants?.length) {
    const availableVariants = pj.variants.filter(v => v.available);

    // Single variant product
    if (availableVariants.length === 1 && Number.isFinite(availableVariants[0]?.inventory_quantity)) {
      return Math.max(0, availableVariants[0].inventory_quantity);
    }

    // If only one total variant exists
    if (pj.variants.length === 1 && Number.isFinite(pj.variants[0]?.inventory_quantity)) {
      return Math.max(0, pj.variants[0].inventory_quantity);
    }
  }

  // 4) Try common theme/product JSON blobs on page
  const qtyFromWindow = await page.evaluate(() => {
    const tryNum = (v) => Number.isFinite(v) ? v : null;

    const roots = [
      window.product,
      window.Product,
      window.__PRODUCT__,
      window.__product,
      window.meta?.product,
      window.ShopifyAnalytics?.meta?.product,
    ].filter(Boolean);

    for (const root of roots) {
      const variants = root?.variants || [];
      if (variants.length === 1) {
        const q =
          tryNum(variants[0]?.inventory_quantity) ??
          tryNum(variants[0]?.inventoryQuantity) ??
          tryNum(variants[0]?.quantity);
        if (q != null) return Math.max(0, q);
      }
    }

    return null;
  }).catch(() => null);

  if (qtyFromWindow != null) return qtyFromWindow;

  return null;
}

export async function extractProduct(page) {
  const url = page.url();

  const pj = await fetchShopifyProductJson(page);

  const title =
    (await page.locator("h1, .product__title, h1.product-title").first().textContent().catch(() => ""))?.trim() ||
    (await page.locator('[itemprop="name"]').first().textContent().catch(() => ""))?.trim() ||
    "";

  const vendor =
    (await page.locator(".product-vendor, a.vendor, .product__vendor").first().textContent().catch(() => ""))?.trim() ||
    (await page.locator('[itemprop="brand"]').first().textContent().catch(() => ""))?.trim() ||
    "";

  let priceText =
    (await page.locator('[itemprop="price"]').first().getAttribute("content").catch(() => null)) ||
    (await page.locator('meta[itemprop="price"]').first().getAttribute("content").catch(() => null)) ||
    (await page.locator("[data-product-price], .price .money, .product__price, .price").first().textContent().catch(() => ""))?.trim() ||
    "";

  let price = parsePrice(priceText);

  let sku =
    (await page.locator('[itemprop="sku"], .product-sku, .sku, .product__sku').first().textContent().catch(() => ""))?.trim() ||
    "";

  let availability =
    (await page.locator('[data-availability], .product-stock, .availability, link[itemprop="availability"]').first().textContent().catch(() => ""))?.trim() ||
    "";

  if ((!availability || availability.toLowerCase() === "instock" || availability.toLowerCase() === "available") && pj?.variants?.length) {
    const anyAvailable = pj.variants.some((v) => v.available);
    availability = anyAvailable ? "InStock" : "OutOfStock";
  }

  if (!availability) availability = "InStock";

  let image =
    (await page.locator('.product__media img, img[src*="/cdn/"], .product-gallery img').first().getAttribute("src").catch(() => null)) ||
    null;

  if (image && !/^https?:\/\//i.test(image)) {
    try {
      image = new URL(image, url).href;
    } catch {}
  }

  if ((!sku || !price) && pj?.variants?.length) {
    const v = pj.variants.find((x) => x.available) || pj.variants[0];
    if (v) {
      if (!sku && v.sku) sku = String(v.sku).trim();
      if (!price && typeof v.price === "number") price = v.price / 100;
    }
    if (!image && pj.images?.length) image = pj.images[0];
  }

  if (!sku) sku = modelFrom(title);

  const stockQuantity = await extractStockQuantity(page, pj);

  const descriptionHtml =
    (await page.locator(".product__description, [itemprop='description'], .rte").first().innerHTML().catch(() => "")) || "";

  return {
    title,
    vendor,
    sku,
    price,
    currency: "ZAR",
    availability,
    stockQuantity, // exact quantity if found
    images: image ? [image] : [],
    url,
    descriptionHtml,
  };
}