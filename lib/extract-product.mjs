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
  const candidates = [
    "main form[action*='/cart/add']",
    "main .product-form",
    "main .product__form",
    "main .product-info",
    "main .product__info-container",
    "main .productView-details",
    "main .product-single__meta",
    "form[action*='/cart/add']",
    ".product-form",
    ".product__form",
    ".product-info",
    ".product__info-container",
    ".productView-details",
    ".product-single__meta",
  ];

  for (const selector of candidates) {
    const loc = page.locator(selector).first();
    const count = await loc.count().catch(() => 0);
    if (count > 0) return loc;
  }

  return page.locator("main").first();
}

async function detectAvailability(page, pj) {
  let availability = "";

  const availHref = await page
    .locator('link[itemprop="availability"]')
    .first()
    .getAttribute("href")
    .catch(() => null);

  if (availHref) {
    if (/OutOfStock/i.test(availHref)) availability = "OutOfStock";
    else if (/InStock/i.test(availHref)) availability = "InStock";
  }

  const productScope = await getProductScope(page);

  if (!availability) {
    const scopedAvailabilityText = cleanTitle(
      (await productScope
        .locator("[data-availability], .product-stock, .availability, .stock, .inventory, .product-inventory")
        .first()
        .textContent()
        .catch(() => "")) || ""
    );

    if (/out[\s-]of[\s-]stock|sold[\s-]out/i.test(scopedAvailabilityText)) {
      availability = "OutOfStock";
    } else if (/in[\s-]stock|available/i.test(scopedAvailabilityText)) {
      availability = "InStock";
    }
  }

  if (
    (!availability ||
      availability.toLowerCase() === "instock" ||
      availability.toLowerCase() === "available") &&
    pj?.variants?.length
  ) {
    const managedVariants = pj.variants.filter((v) => v.inventory_quantity !== null);

    if (managedVariants.length > 0) {
      const anyAvailable = managedVariants.some((v) => v.available);
      availability = anyAvailable ? "InStock" : "OutOfStock";
    }
  }

  if (!availability) {
    const scopeText = cleanTitle((await productScope.textContent().catch(() => "")) || "");

    const minusBtn = await productScope
      .locator("button, input[type='button'], input[type='submit']")
      .evaluateAll((els) =>
        els.some((el) => {
          const t = String(el.textContent || el.value || "").trim();
          return t === "−" || t === "-" || /minus/i.test(t);
        })
      )
      .catch(() => false);

    const plusBtn = await productScope
      .locator("button, input[type='button'], input[type='submit']")
      .evaluateAll((els) =>
        els.some((el) => {
          const t = String(el.textContent || el.value || "").trim();
          return t === "+" || /plus/i.test(t);
        })
      )
      .catch(() => false);

    const addToCartPresent = await productScope
      .locator("button, input[type='submit'], a")
      .evaluateAll((els) =>
        els.some((el) => /add\s*to\s*cart/i.test(String(el.textContent || el.value || "")))
      )
      .catch(() => false);

    const outOfStockMarker = await productScope
      .locator(
        [
          ".aca-product-out-of-stock-button",
          "[data-stock-status='out']",
          "[data-availability='out']",
          "[aria-disabled='true']",
          "text=/out[\\s-]?of[\\s-]?stock/i",
          "text=/sold[\\s-]?out/i",
        ].join(", ")
      )
      .count()
      .catch(() => 0);

    if (outOfStockMarker > 0 || /out[\s-]of[\s-]stock|sold[\s-]out/i.test(scopeText)) {
      availability = "OutOfStock";
    } else if (addToCartPresent || (minusBtn && plusBtn)) {
      availability = "InStock";
    }
  }

  if (!availability) availability = "InStock";

  return availability;
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

export async function extractProduct(page) {
  const url = page.url();

  await page.waitForLoadState("networkidle").catch(() => { });
  await page.waitForTimeout(250).catch(() => { });

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

  const availability = await detectAvailability(page, pj);

  let image =
    (await page.locator('.product__media img, img[src*="/cdn/"], .product-gallery img').first().getAttribute("src").catch(() => null)) ||
    null;

  if (image && !/^https?:\/\//i.test(image)) {
    try {
      image = new URL(image, url).href;
    } catch { }
  }

  if (pj?.variants?.length) {
    const v = pj.variants.find((x) => x.available) || pj.variants[0];
    if (v) {
      if (!sku && v.sku) sku = String(v.sku).trim();
      if (!price && typeof v.price === "number") price = v.price / 100;
    }
    if (!image && pj.images?.length) image = pj.images[0];
  }

  if (!sku) sku = modelFrom(title);

  const stockQuantity = await extractStockQuantity(page, pj, availability);

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
    images: image ? [image] : [],
    url,
    descriptionHtml,
  };
}