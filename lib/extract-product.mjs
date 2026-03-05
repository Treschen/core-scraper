// lib/extract-product.mjs
import { parsePrice, modelFrom, canonicalHandle } from "./normalize.mjs";

/**
 * Fetch Shopify product JSON from /products/<handle>.js
 * This is the most reliable source for title/vendor/images/variants.
 */
async function fetchShopifyProductJson(page) {
  try {
    const url = new URL(page.url());
    const handle = canonicalHandle(url.href);
    if (!handle) return null;

    const apiUrl = `${url.origin}/products/${handle}.js`;

    // Use page.evaluate fetch to avoid CORS/sandbox edge cases
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
  return (
    !x ||
    x === "search" ||
    x === "customer login" ||
    x === "account" ||
    x === "login"
  );
}

function uniqKeepOrder(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const k = String(v || "").trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

export async function extractProduct(page) {
  const url = page.url();

  // Fetch Shopify JSON first (Core is standard Shopify handles)
  const pj = await fetchShopifyProductJson(page);

  // ----------------------------
  // TITLE (prefer product.js)
  // ----------------------------
  let title = "";
  if (pj?.title && !isBadTitle(pj.title)) {
    title = cleanText(pj.title);
  }

  // OG title fallback
  if (!title) {
    const ogTitle = await page
      .locator('meta[property="og:title"]')
      .first()
      .getAttribute("content")
      .catch(() => "");
    if (!isBadTitle(ogTitle)) title = cleanText(ogTitle);
  }

  // Scoped DOM fallback (avoid global header search H1)
  if (!title) {
    const domTitle = cleanText(
      await page
        .locator(
          "main .product__title, main h1.product__title, main h1.product-title, main [itemprop='name'], main h1"
        )
        .first()
        .textContent()
        .catch(() => "")
    );
    if (!isBadTitle(domTitle)) title = domTitle;
  }

  // Last resort: page title
  if (!title) {
    const pt = cleanText(await page.title().catch(() => ""));
    if (!isBadTitle(pt)) title = pt;
  }

  // ----------------------------
  // VENDOR (prefer product.js)
  // ----------------------------
  let vendor = "";
  if (pj?.vendor) vendor = cleanText(pj.vendor);

  if (!vendor) {
    vendor = cleanText(
      await page
        .locator(".product-vendor, a.vendor, .product__vendor, [itemprop='brand']")
        .first()
        .textContent()
        .catch(() => "")
    );
  }

  // ----------------------------
  // IMAGES (ALL images)
  // Prefer product.js images array
  // ----------------------------
  let images = [];

  if (Array.isArray(pj?.images) && pj.images.length) {
    images = uniqKeepOrder(
      pj.images.map((u) => (typeof u === "string" ? u.trim() : "")).filter(Boolean)
    );
  }

  // DOM fallback if pj.images missing
  if (!images.length) {
    const domImages = await page
      .$$eval(
        'main img[src*="/cdn/"], img[src*="/cdn/"], .product__media img, .product-gallery img',
        (els) =>
          els
            .map((img) => img.getAttribute("src") || img.getAttribute("data-src") || "")
            .filter(Boolean)
      )
      .catch(() => []);

    // Make absolute
    images = uniqKeepOrder(
      domImages.map((src) => {
        try {
          return new URL(src, window.location.origin).href;
        } catch {
          return src;
        }
      })
    );
  }

  // ----------------------------
  // PRICE (prefer product.js variant cents)
  // ----------------------------
  let price = 0;

  // Try DOM meta first (some themes expose it reliably)
  const metaPrice =
    (await page
      .locator('meta[itemprop="price"]')
      .first()
      .getAttribute("content")
      .catch(() => null)) ||
    (await page
      .locator('[itemprop="price"]')
      .first()
      .getAttribute("content")
      .catch(() => null));

  if (metaPrice) price = parsePrice(metaPrice);

  // DOM visible price fallback
  if (!price || price === 0) {
    const priceText = cleanText(
      await page
        .locator("[data-product-price], .price .money, .product__price, .price")
        .first()
        .textContent()
        .catch(() => "")
    );
    price = parsePrice(priceText);
  }

  // If DOM failed, use product.js (cents)
  if ((!price || price === 0) && Array.isArray(pj?.variants) && pj.variants.length) {
    const v = pj.variants.find((x) => x?.available) || pj.variants[0];
    if (v && typeof v.price === "number") {
      price = v.price / 100;
    }
  }

  // FINAL PRICE ROUNDING (fix float noise)
  if (typeof price === "number" && Number.isFinite(price)) {
    price = Math.round(price * 100) / 100;
  }

  // ----------------------------
  // SKU (DOM → product.js → modelFrom(title))
  // ----------------------------
  let sku = cleanText(
    await page
      .locator('[itemprop="sku"], .product-sku, .sku, .product__sku')
      .first()
      .textContent()
      .catch(() => "")
  );

  if (!sku && Array.isArray(pj?.variants) && pj.variants.length) {
    const v = pj.variants.find((x) => x?.available) || pj.variants[0];
    if (v?.sku) sku = cleanText(String(v.sku));
  }

  if (!sku) sku = modelFrom(title);

  // ----------------------------
  // AVAILABILITY (prefer product.js)
  // ----------------------------
  let availability = "";

  if (Array.isArray(pj?.variants) && pj.variants.length) {
    const anyAvailable = pj.variants.some((v) => v?.available);
    availability = anyAvailable ? "InStock" : "OutOfStock";
  } else {
    availability = cleanText(
      await page
        .locator(
          "[data-availability], .product-stock, .availability, link[itemprop='availability']"
        )
        .first()
        .textContent()
        .catch(() => "")
    );
    if (!availability) availability = "InStock";
  }

  // ----------------------------
  // DESCRIPTION (optional)
  // ----------------------------
  const descriptionHtml =
    (await page
      .locator(".product__description, [itemprop='description'], .rte")
      .first()
      .innerHTML()
      .catch(() => "")) || "";

  return {
    title,
    vendor,
    sku,
    price, // number in ZAR
    currency: "ZAR",
    availability,
    images, // ✅ full list
    url,
    descriptionHtml,
  };
}