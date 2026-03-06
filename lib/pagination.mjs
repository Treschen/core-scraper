// lib/pagination.mjs

function dedupeProductUrls(hrefs, origin) {
  const badHandles = new Set([
    "search",
    "all",
    "collections",
    "products",
  ]);

  const out = new Set();

  for (const raw of hrefs || []) {
    try {
      const u = new URL(raw, origin);
      const m = u.pathname.match(/^\/products\/([^/?#]+)$/i);
      if (!m) continue;

      const handle = decodeURIComponent(m[1]).trim().toLowerCase();
      if (!handle) continue;
      if (badHandles.has(handle)) continue;

      out.add(`${u.origin}/products/${handle}`);
    } catch {
      // ignore bad urls
    }
  }

  return Array.from(out);
}

function getCollectionHandleFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/collections\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]).trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

function getCurrentPageNumber(url) {
  try {
    const u = new URL(url);
    const p = parseInt(u.searchParams.get("page") || "1", 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  } catch {
    return 1;
  }
}

export async function getProductLinksOnPage(page) {
  const currentUrl = page.url();
  const { origin } = new URL(currentUrl);

  // Let theme JS settle first
  await page.waitForTimeout(2500).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});

  const selectorCandidates = [
    'main a[href*="/products/"]',
    '.shopify-section a[href*="/products/"]',
    '.product-grid a[href*="/products/"]',
    '.grid a[href*="/products/"]',
    '.grid__item a[href*="/products/"]',
    '.card-wrapper a[href*="/products/"]',
    '.card a[href*="/products/"]',
    '.product-card a[href*="/products/"]',
    '.product-item a[href*="/products/"]',
    '[class*="product"] a[href*="/products/"]',
    'a[href*="/products/"]',
  ];

  for (const selector of selectorCandidates) {
    const hrefs = await page
      .locator(selector)
      .evaluateAll((els) => {
        const badTexts = new Set([
          "search",
          "view all",
          "all",
          "shop all",
          "quick add",
          "quick view",
        ]);

        const out = [];

        for (const el of els) {
          const href = el.getAttribute("href") || "";
          const text = String(el.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

          if (!href) continue;
          if (!href.includes("/products/")) continue;
          if (href.includes("/search")) continue;
          if (href.includes("/collections/")) continue;
          if (href.includes("/pages/")) continue;
          if (href.includes("?q=")) continue;
          if (badTexts.has(text)) continue;

          out.push(href);
        }

        return out;
      })
      .catch(() => []);

    const cleaned = dedupeProductUrls(hrefs, origin);
    if (cleaned.length) {
      return cleaned;
    }
  }

  // Fallback 1: inspect scripts for product URLs
  const scriptUrls = await page
    .evaluate(() => {
      const found = new Set();
      const scripts = Array.from(
        document.querySelectorAll('script[type="application/ld+json"], script')
      );

      for (const s of scripts) {
        const txt = s.textContent || "";
        if (!txt || !txt.includes("/products/")) continue;

        const matches = txt.match(/\/products\/[a-zA-Z0-9-_%.]+/g) || [];
        for (const m of matches) found.add(m);
      }

      return Array.from(found);
    })
    .catch(() => []);

  const fallbackFromScripts = dedupeProductUrls(scriptUrls, origin);
  if (fallbackFromScripts.length) {
    return fallbackFromScripts;
  }

  // Fallback 2: Shopify collection JSON endpoint
  const collectionHandle = getCollectionHandleFromUrl(currentUrl);
  const pageNo = getCurrentPageNumber(currentUrl);

  if (collectionHandle) {
    const apiUrl = `${origin}/collections/${collectionHandle}/products.json?limit=250&page=${pageNo}`;

    const jsonLinks = await page
      .evaluate(async (endpoint) => {
        try {
          const r = await fetch(endpoint, {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              accept: "application/json, text/plain, */*",
            },
          });

          if (!r.ok) return [];

          const data = await r.json();
          const products = Array.isArray(data?.products) ? data.products : [];

          return products
            .map((p) => p?.handle)
            .filter(Boolean)
            .map((handle) => `/products/${handle}`);
        } catch {
          return [];
        }
      }, apiUrl)
      .catch(() => []);

    const fallbackFromJson = dedupeProductUrls(jsonLinks, origin);
    if (fallbackFromJson.length) {
      return fallbackFromJson;
    }
  }

  return [];
}

export async function getNextPageUrl(page, foundCount = null) {
  const currentUrl = page.url();

  // First try normal pagination controls
  const domNext = await page.evaluate(() => {
    const absHref = (el) => {
      try {
        return new URL((el.getAttribute("href") || "").trim(), location.origin).href;
      } catch {
        return null;
      }
    };

    const relNext = document.querySelector('a[rel="next"]');
    if (relNext) {
      const href = absHref(relNext);
      if (href) return href;
    }

    const nextNum = document.querySelector(
      ".pagination .active + li a, .pagination__item--current + a"
    );
    if (nextNum) {
      const href = absHref(nextNum);
      if (href) return href;
    }

    const nextText = Array.from(document.querySelectorAll("a,button")).find((el) =>
      /next/i.test(el.textContent || "")
    );
    if (nextText) {
      const href = absHref(nextText);
      if (href) return href;
    }

    return null;
  }).catch(() => null);

  if (domNext) return domNext;

  // JSON fallback pagination:
  // if current page returned products, try next ?page=N+1
  if (foundCount && foundCount > 0) {
    try {
      const u = new URL(currentUrl);
      const currentPage = parseInt(u.searchParams.get("page") || "1", 10) || 1;
      u.searchParams.set("page", String(currentPage + 1));
      return u.href;
    } catch {
      return null;
    }
  }

  return null;
}