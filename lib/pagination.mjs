export async function getProductLinksOnPage(page) {
  const { origin } = new URL(page.url());

  const handles = await page.evaluate(() => {
    const hs = new Set();

    const takeHandleFromHref = (href) => {
      try {
        const u = new URL(href, location.origin);
        if (!u.pathname.toLowerCase().includes("/products/")) return null;
        const m = u.pathname.match(/\/products\/([^/?#]+)/i);
        return m ? m[1] : null;
      } catch {
        return null;
      }
    };

    // 1) Normal anchors
    for (const a of document.querySelectorAll('a[href*="/products/"]')) {
      const h = takeHandleFromHref(a.getAttribute("href") || "");
      if (h) hs.add(h);
    }

    // 2) Some themes store product URLs in data attributes
    const dataAttrs = ["data-product-url", "data-url", "data-href"];
    for (const el of document.querySelectorAll("[data-product-url],[data-url],[data-href]")) {
      for (const attr of dataAttrs) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const h = takeHandleFromHref(v);
        if (h) hs.add(h);
      }
    }

    // 3) Shopify section JSON sometimes includes product handles
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const txt = (s.textContent || "").trim();
      if (!txt || txt.length > 2_000_000) continue;
      if (!txt.includes("products") && !txt.includes("/products/")) continue;

      // very safe: extract /products/<handle> occurrences
      const re = /\/products\/([a-z0-9\-]+)\b/gi;
      let m;
      while ((m = re.exec(txt))) {
        if (m[1]) hs.add(m[1]);
      }
    }

    return Array.from(hs);
  });

  // Build canonical URLs (no query/fragment)
  return handles.map((h) => `${origin}/products/${h}`);
}

export async function getNextPageUrl(page) {
  return await page.evaluate(() => {
    const absHref = (el) => {
      try {
        const href = (el.getAttribute("href") || "").trim();
        if (!href) return null;
        return new URL(href, location.origin).href;
      } catch {
        return null;
      }
    };

    // 1) rel="next"
    const relNext = document.querySelector('a[rel="next"]');
    if (relNext) {
      const href = absHref(relNext);
      if (href) return href;
    }

    // 2) common Shopify paginator patterns
    const candidates = [
      ".pagination .active + li a",
      ".pagination__item--current + a",
      ".pagination__list .pagination__item--current + li a",
      'a[aria-label="Next"]',
      'a[aria-label*="next" i]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const href = absHref(el);
        if (href) return href;
      }
    }

    // 3) button/link with next text
    const nextText = Array.from(document.querySelectorAll("a"))
      .find((el) => /next/i.test((el.textContent || "").trim()));
    if (nextText) {
      const href = absHref(nextText);
      if (href) return href;
    }

    return null;
  });
}