// lib/pagination.mjs
// Handles:
// 1) Extracting product links on a collection page
// 2) Clicking "items per page" to max (50) when available
// 3) Finding next page URL, including hidden infinite-scroll data-href

export async function getProductLinksOnPage(page) {
  // Return ONE canonical product URL per handle, ignoring ?variant=... etc.
  const { origin } = new URL(page.url());

  // Small wait for grids rendered
  await page.waitForTimeout(500);

  const handles = await page.evaluate(() => {
    const toHandle = (raw) => {
      try {
        const u = new URL(String(raw || ""), location.origin);
        if (!/\/products\//i.test(u.pathname)) return null;
        const m = u.pathname.match(/\/products\/([^/?#]+)/i);
        return m ? m[1] : null;
      } catch {
        return null;
      }
    };

    const out = new Set();

    // 1) Standard anchors
    const anchors = Array.from(document.querySelectorAll('a[href*="/products/"]'));
    for (const a of anchors) {
      const h = toHandle(a.getAttribute("href"));
      if (h) out.add(h);
    }

    // 2) Some themes store product urls on containers/buttons
    const dataEls = Array.from(document.querySelectorAll('[data-product-url],[data-href],[data-url]'));
    for (const el of dataEls) {
      const h =
        toHandle(el.getAttribute("data-product-url")) ||
        toHandle(el.getAttribute("data-href")) ||
        toHandle(el.getAttribute("data-url"));
      if (h) out.add(h);
    }

    return Array.from(out);
  }).catch(() => []);

  return handles.map(h => `${origin}/products/${h}`);
}

export async function setItemsPerPageToMax(page) {
  // Theme markup from debug-page.html:
  // div.filters-toolbar__limited-view .label-tab opens ul.dropdown-menu span[data-value]
  const labelTab = page.locator('.filters-toolbar__limited-view .label-tab').first();
  const maxOption = page.locator(
    '.filters-toolbar__limited-view ul.dropdown-menu span[data-value]'
  );

  const hasDropdown = await labelTab.isVisible().catch(() => false);
  if (!hasDropdown) {
    console.log("  [items-per-page] dropdown not found or not visible");
    return;
  }

  // Find max numeric option (usually 50)
  const values = await maxOption.evaluateAll(els =>
    els.map(e => parseInt(e.getAttribute("data-value") || "0", 10)).filter(n => n > 0)
  ).catch(() => []);

  if (!values.length) {
    console.log("  [items-per-page] dropdown not found or has no options");
    return;
  }

  const maxVal = Math.max(...values);

  // Open dropdown
  await labelTab.click().catch(() => {});
  await page.waitForTimeout(300);

  // Click max option
  const opt = page.locator(
    `.filters-toolbar__limited-view ul.dropdown-menu span[data-value="${maxVal}"]`
  ).first();

  if (await opt.isVisible().catch(() => false)) {
    console.log(`  [items-per-page] setting to ${maxVal}`);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      opt.click().catch(() => {}),
    ]);

    // Give the theme time to re-render products
    await page.waitForTimeout(1200);
  } else {
    console.log("  [items-per-page] max option not clickable");
  }
}

export async function getNextPageUrl(page) {
  // 1) Standard Shopify rel="next"
  const relNext = page.locator('a[rel="next"]').first();
  if (await relNext.isVisible().catch(() => false)) {
    const href = await relNext.getAttribute("href").catch(() => null);
    if (href) return new URL(href, page.url()).toString();
  }

  // 2) Classic pagination "next" button
  const classicNext = page.locator(
    [
      '.pagination a[title*="Next"]',
      '.pagination a.next',
      'a.pagination__next',
      'a:has-text("Next")'
    ].join(",")
  ).first();

  if (await classicNext.isVisible().catch(() => false)) {
    const href = await classicNext.getAttribute("href").catch(() => null);
    if (href) return new URL(href, page.url()).toString();
  }

  // 3) Hidden infinite-scroll "Show more" data-href
  // Present even when parent has class "hide"
  const infiniteBtn = page.locator('.infinite-scrolling a.btn[data-href]').first();
  const dataHref = await infiniteBtn.getAttribute("data-href").catch(() => null);

  if (dataHref) {
    const nextUrl = new URL(dataHref, page.url()).toString();
    return nextUrl;
  }

  return null;
}
