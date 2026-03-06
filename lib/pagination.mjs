// lib/pagination.mjs

export async function getProductLinksOnPage(page) {
  const { origin } = new URL(page.url());

  const handles = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/products/"]'));

    const badHandles = new Set([
      "search",
      "all",
      "collections",
      "products",
    ]);

    const badTexts = new Set([
      "search",
      "view all",
      "all",
      "shop all",
      "quick add",
      "quick view",
    ]);

    const isVisible = (el) => {
      try {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        return (
          style &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      } catch {
        return false;
      }
    };

    const normaliseText = (s) =>
      String(s || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const toHandle = (href) => {
      try {
        const u = new URL(href, location.origin);

        if (!/^\/products\/[^/?#]+$/i.test(u.pathname)) return null;
        if (u.pathname.includes("/collections/")) return null;
        if (u.pathname.includes("/search")) return null;

        const m = u.pathname.match(/^\/products\/([^/?#]+)$/i);
        if (!m) return null;

        const handle = decodeURIComponent(m[1]).trim().toLowerCase();
        if (!handle) return null;
        if (badHandles.has(handle)) return null;

        return handle;
      } catch {
        return null;
      }
    };

    const looksLikeProductCard = (a) => {
      return !!(
        a.closest(".card-wrapper") ||
        a.closest(".card") ||
        a.closest(".grid__item") ||
        a.closest(".product-card") ||
        a.closest(".product-grid-item") ||
        a.closest(".product-item") ||
        a.closest('[class*="product"]')
      );
    };

    const seen = new Set();

    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const text = normaliseText(a.textContent);

      if (!href) continue;
      if (href.includes("/search")) continue;
      if (href.includes("?q=")) continue;
      if (href.includes("/pages/")) continue;
      if (badTexts.has(text)) continue;
      if (!isVisible(a)) continue;

      const handle = toHandle(href);
      if (!handle) continue;

      // Prefer anchors that actually live in a product card/grid item
      if (!looksLikeProductCard(a)) continue;

      seen.add(handle);
    }

    return Array.from(seen);
  });

  return handles.map((handle) => `${origin}/products/${handle}`);
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