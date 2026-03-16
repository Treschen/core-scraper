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

function cleanTitle(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}

function isBadTitle(s = "") {
  const t = cleanTitle(s).toLowerCase();
  return !t || t === "search" || t === "account" || t === "cart" || t === "login";
}

async function getProductScope(page) {
  const selectors = [
    'form[action*="/cart/add"]',
    ".product-form",
    ".product__form",
    ".product-info",
    ".product__info-container",
    ".product-single__meta",
    ".productView-details",
    "main"
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    const count = await loc.count().catch(() => 0);
    if (count > 0) return loc;
  }

  return page.locator("body").first();
}

async function detectAvailability(page, pj) {
  const productScope = await getProductScope(page);

  // 1) Strongest signal: visible sold-out text inside buy box / product scope
  const scopeText = cleanTitle((await productScope.textContent().catch(() => "")) || "");
  if (/out[\s-]?of[\s-]?stock|sold[\s-]?out/i.test(scopeText)) {
    return "OutOfStock";
  }

  // 2) Schema availability
  const availHref = await page
    .locator('link[itemprop="availability"]')
    .first()
    .getAttribute("href")
    .catch(() => null);

  if (availHref) {
    if (/OutOfStock/i.test(availHref)) return "OutOfStock";
    if (/InStock/i.test(availHref)) return "InStock";
  }

  // 3) Scoped DOM availability text
  const scopedAvailabilityText = cleanTitle(
    (await productScope
      .locator('[data-availability], .product-stock, .availability, .stock, .inventory, .product-inventory')
      .first()
      .textContent()
      .catch(() => "")) || ""
  );

  if (/out[\s-]?of[\s-]?stock|sold[\s-]?out/i.test(scopedAvailabilityText)) {
    return "OutOfStock";
  }
  if (/in[\s-]?stock|available/i.test(scopedAvailabilityText)) {
    return "InStock";
  }

  // 4) Explicit scoped sold-out markers
  const scopedOutMarkers = await productScope
    .locator(
      [
        ".aca-product-out-of-stock-button",
        "[data-stock-status='out']",
        "[data-availability='out']",
        '[class*="out-of-stock"]',
        '[class*="sold-out"]',
        "text=/out[\\s-]?of[\\s-]?stock/i",
        "text=/sold[\\s-]?out/i"
      ].join(", ")
    )
    .count()
    .catch(() => 0);

  if (scopedOutMarkers > 0) {
    return "OutOfStock";
  }

  // 5) Managed Shopify inventory
  if (pj?.variants?.length) {
    const managedVariants = pj.variants.filter((v) => v.inventory_quantity !== null);
    if (managedVariants.length > 0) {
      const anyAvailable = managedVariants.some((v) => v.available);
      return anyAvailable ? "InStock" : "OutOfStock";
    }
  }

  // 6) Positive in-stock signals inside scope
  const addToCartPresent = await productScope
    .locator("button, input[type='submit'], a")
    .evaluateAll((els) =>
      els.some((el) => /add\s*to\s*cart/i.test(String(el.textContent || el.value || "")))
    )
    .catch(() => false);

  const qtyButtonsPresent = await productScope
    .locator("button, input[type='button']")
    .evaluateAll((els) => {
      const texts = els.map((el) => String(el.textContent || el.value || "").trim());
      const hasMinus = texts.some((t) => t === "−" || t === "-" || /minus/i.test(t));
      const hasPlus = texts.some((t) => t === "+" || /plus/i.test(t));
      return hasMinus && hasPlus;
    })
    .catch(() => false);

  if (addToCartPresent || qtyButtonsPresent) {
    return "InStock";
  }

  // 7) Default unknown to OutOfStock for Core, not InStock
  return "OutOfStock";
}

async function extractStockQuantity(page, pj, availability = "") {
  if (/outofstock/i.test(String(availability).replace(/[^a-z]/gi, ""))) {
    return 0;
  }

  const productScope = await getProductScope(page);
  const scopeText = (await productScope.textContent().catch(() => "")) || "";

  const m1 = scopeText.match(/\b(\d+)\s+items?\s+left\b/i);
  if (m1) return parseInt(m1[1], 10);

  const candidateTexts = await productScope.locator("span, div, p, small").allTextContents().catch(() => []);
  for (const t of candidateTexts) {
    const m = String(t).match(/\b(\d+)\s+items?\s+left\b/i);
    if (m) return parseInt(m[1], 10);
  }

  if (pj?.variants?.length) {
    const availableVariants = pj.variants.filter((v) => v.available);

    if (availableVariants.length === 1 && Number.isFinite(availableVariants[0]?.inventory_quantity)) {
      return Math.max(0, availableVariants[0].inventory_quantity);
    }

    if (pj.variants.length === 1 && Number.isFinite(pj.variants[0]?.inventory_quantity)) {
      return Math.max(0, pj.variants[0].inventory_quantity);
    }
  }

  const qtyFromWindow = await page
    .evaluate(() => {
      const tryNum = (v) => (Number.isFinite(v) ? v : null);

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
    })
    .catch(() => null);

  if (qtyFromWindow != null) return qtyFromWindow;

  return null;
}

async function extractImages(page, pj, url) {
  const scopedImage = await page
    .locator(
      [
        '.product__media img[src]',
        '.product-gallery img[src]',
        '.product-gallery__image img[src]',
        '.product-single__photo img[src]',
        '[data-product-image] img[src]',
        'main img[src*="/products/"]'
      ].join(", ")
    )
    .first()
    .getAttribute("src")
    .catch(() => null);

  let image = scopedImage || null;

  if (!image && pj?.images?.length) {
    image = pj.images[0];
  }

  if (image && !/^https?:\/\//i.test(image)) {
    try {
      image = new URL(image, url).href;
    } catch { }
  }

  return image ? [image] : [];
}

export async function extractProduct(page) {
  const url = page.url();

  await page.waitForLoadState("networkidle").catch(() => { });
  await page.waitForTimeout(350).catch(() => { });

  const pj = await fetchShopifyProductJson(page);

  let title = cleanTitle(pj?.title || "");
  if (!title) {
    const titleCandidates = await page
      .locator("h1, .product__title, h1.product-title, [itemprop='name']")
      .allTextContents()
      .catch(() => []);

    const good = titleCandidates.map(cleanTitle).find((t) => !isBadTitle(t));
    title = good || "";
  }

  const vendor =
    cleanTitle(pj?.vendor || "") ||
    cleanTitle(
      (await page.locator(".product-vendor, a.vendor, .product__vendor").first().textContent().catch(() => "")) || ""
    ) ||
    cleanTitle((await page.locator('[itemprop="brand"]').first().textContent().catch(() => "")) || "") ||
    "";

  let priceText =
    (await page.locator('[itemprop="price"]').first().getAttribute("content").catch(() => null)) ||
    (await page.locator('meta[itemprop="price"]').first().getAttribute("content").catch(() => null)) ||
    cleanTitle(
      (await page.locator("[data-product-price], .price .money, .product__price, .price").first().textContent().catch(() => "")) || ""
    ) ||
    "";

  let price = parsePrice(priceText);

  let sku =
    cleanTitle(
      (await page.locator('[itemprop="sku"], .product-sku, .sku, .product__sku').first().textContent().catch(() => "")) || ""
    ) || "";

  if (pj?.variants?.length) {
    const v = pj.variants.find((x) => x.available) || pj.variants[0];
    if (v) {
      if (!sku && v.sku) sku = String(v.sku).trim();
      if (!price && typeof v.price === "number") price = v.price / 100;
    }
  }

  if (!sku) sku = modelFrom(title);

  const availability = await detectAvailability(page, pj);
  const stockQuantity = await extractStockQuantity(page, pj, availability);
  const images = await extractImages(page, pj, url);

  const descriptionHtml =
    (await page.locator(".product__description, [itemprop='description'], .rte").first().innerHTML().catch(() => "")) || "";

  return {
    title,
    vendor,
    sku,
    price,
    currency: "ZAR",
    availability,
    stockQuantity,
    images,
    url,
    descriptionHtml,
  };
}