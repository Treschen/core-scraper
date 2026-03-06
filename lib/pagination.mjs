// lib/pagination.mjs

export async function getProductLinksOnPage(page) {
  const { origin } = new URL(page.url());

  // Let Shopify/theme JS finish rendering product cards
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

          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const visible =
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;

          if (!visible) continue;

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

  // Fallback 1: grab every /products/ link and sanitize hard
  const allHrefs = await page
    .locator('a[href*="/products/"]')
    .evaluateAll((els) =>
      els.map((el) => ({
        href: el.getAttribute("href") || "",
        text: String(el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase(),
      }))
    )
    .catch(() => []);

  const fallback1 = dedupeProductUrls(
    allHrefs
      .filter(({ href, text }) => {
        if (!href) return false;
        if (href.includes("/search")) return false;
        if (href.includes("/collections/")) return false;
        if (href.includes("/pages/")) return false;
        if (href.includes("?q=")) return false;
        if (text === "search" || text === "view all" || text === "all") return false;
        return true;
      })
      .map(({ href }) => href),
    origin
  );

  if (fallback1.length) {
    return fallback1;
  }

  // Fallback 2: inspect scripts for product URLs
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

  const fallback2 = dedupeProductUrls(scriptUrls, origin);
  if (fallback2.length) {
    return fallback2;
  }

  return [];
}

export async function getNextPageUrl(page) {
  return await page.evaluate(() => {
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
  });
}

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