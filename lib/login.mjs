import fs from "fs";

// Where to read/write session cookies.
// In Docker this is the core_auth volume: /app/.auth/cookies.json
const COOKIES_FILE = process.env.COOKIES_FILE || "/app/.auth/cookies.json";

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/** Normalise a cookie array exported from Chrome (Cookie-Editor extension)
 *  or Playwright's own storageState format into Playwright's addCookies shape.
 */
function normalizeCookies(raw) {
  const sameSiteMap = (s = "") => {
    const v = String(s).toLowerCase();
    if (v === "strict") return "Strict";
    if (v === "none" || v === "no_restriction") return "None";
    return "Lax";
  };

  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    // Chrome extensions omit the leading dot; Playwright needs it for subdomain match
    domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
    path: c.path || "/",
    // Chrome uses expirationDate, Playwright uses expires
    expires: c.expires ?? c.expirationDate ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: sameSiteMap(c.sameSite),
  }));
}

/** Try to authenticate by injecting saved cookies instead of using the
 *  login form (which is blocked by hCaptcha in headless mode).
 *  Returns true if the session is valid after injection.
 */
async function tryCookieLogin(page, base) {
  try {
    if (!fs.existsSync(COOKIES_FILE)) {
      console.log("[login] no cookies file found at", COOKIES_FILE);
      return false;
    }

    const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
    if (!Array.isArray(raw) || !raw.length) {
      console.log("[login] cookies file is empty or invalid");
      return false;
    }

    const cookies = normalizeCookies(raw);
    await page.context().addCookies(cookies);
    console.log(`[login] injected ${cookies.length} cookies from ${COOKIES_FILE}`);

    // Probe /account to confirm the session is still valid
    const accountUrl = `${base.replace(/\/+$/, "")}/account`;
    await page.goto(accountUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    const u = page.url();
    const hasLogout = await page
      .locator('a[href*="/account/logout"]')
      .first()
      .isVisible()
      .catch(() => false);
    const onAccount =
      /\/account(\/(?!login)|$)/.test(u) && !/\/account\/login/.test(u);

    if (onAccount || hasLogout) {
      console.log("[login] cookie login successful, url:", u);
      return true;
    }

    console.log("[login] cookies injected but session is invalid/expired, url:", u);
    return false;
  } catch (e) {
    console.log("[login] cookie login error:", e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function loginIfNeeded(page, { base, email, password }) {
  // Skip entirely if no base URL provided
  if (!base) return;

  const loginUrl  = `${base.replace(/\/+$/, "")}/account/login`;
  const accountUrl = `${base.replace(/\/+$/, "")}/account`;

  const isLoginPage   = (u) => /\/account\/login/.test(u);
  const isAccountPage = (u) => /\/account(\/(?!login)|$)/.test(u);

  async function hasLogoutMarker(p) {
    return p.locator('a[href*="/account/logout"]').first().isVisible().catch(() => false);
  }

  async function probeAccount() {
    await page.goto(accountUrl, { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    const u      = page.url();
    const logout = await hasLogoutMarker(page);
    return { url: u, ok: (isAccountPage(u) && !isLoginPage(u)) || logout, logout };
  }

  // ── 1. Try cookie-based auth first (bypasses hCaptcha entirely) ──────────
  const cookieOk = await tryCookieLogin(page, base);
  if (cookieOk) return;

  // ── 2. Fall back to form login (requires email + password) ───────────────
  if (!email || !password) {
    throw new Error(
      "Login failed: no valid cookies found and no credentials provided. " +
      `Export your session cookies from Chrome to ${COOKIES_FILE} — see README.`
    );
  }

  console.log("[login] cookie login unavailable, attempting form login...");
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  console.log("[login] on page:", page.url());

  // Best-effort cookie banners — short timeout so missing buttons fail fast
  await page.getByRole("button", { name: /accept|agree|ok/i }).first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('button:has-text("Accept")').first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('button:has-text("I Accept")').first().click({ timeout: 2000 }).catch(() => {});

  // If already logged in
  if (isAccountPage(page.url()) && !isLoginPage(page.url())) {
    const logout = await hasLogoutMarker(page);
    if (logout) { console.log("[login] already logged in, skipping."); return; }
  }

  const form = page.locator('form[action*="/account/login"], form[action="/account/login"]').first();

  const emailInput = form.locator(
    'input[name="customer[email]"], #CustomerEmail, #customer_email, input[type="email"], input[name="email"]'
  ).first();
  const passInput = form.locator(
    'input[name="customer[password]"], #CustomerPassword, #customer_password, input[type="password"], input[name="password"]'
  ).first();

  const emailVisible = await emailInput.isVisible().catch(() => false);
  const passVisible  = await passInput.isVisible().catch(() => false);
  console.log("[login] form fields visible — email:", emailVisible, "password:", passVisible);

  if (!emailVisible || !passVisible) {
    throw new Error("Login failed: could not find email/password fields on login page.");
  }

  await emailInput.fill(email, { timeout: 15000 });
  await passInput.fill(password, { timeout: 15000 });
  console.log("[login] credentials filled, submitting...");

  const waitLoginResponse = page.waitForResponse(
    (r) => r.url().includes("/account/login") &&
            r.request().method().toUpperCase() === "POST",
    { timeout: 20000 }
  ).catch(() => null);

  const submitBtn = form.locator(
    'button[type="submit"], input[type="submit"], button[name="commit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")'
  ).first();

  if (await submitBtn.isVisible().catch(() => false)) {
    await submitBtn.click({ timeout: 15000 }).catch(() => {});
  } else {
    await passInput.press("Enter").catch(() => {});
    await page.evaluate(() => {
      const f = document.querySelector('form[action*="/account/login"], form[action="/account/login"]');
      if (f) f.submit();
    }).catch(() => {});
  }

  const resp = await waitLoginResponse;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);

  const postUrl = page.url();
  const status  = resp ? resp.status() : null;
  console.log("[login] post-submit url:", postUrl, "loginRespStatus:", status);

  const onAccountNow = isAccountPage(postUrl) && !isLoginPage(postUrl);
  const hasLogoutNow = await hasLogoutMarker(page);
  console.log("[login] onAccount:", onAccountNow, "hasLogout:", hasLogoutNow);

  if (onAccountNow || hasLogoutNow) { console.log("[login] login successful."); return; }

  const probe = await probeAccount();
  console.log("[login] probe /account:", probe.url, "ok:", probe.ok);
  if (probe.ok) { console.log("[login] login successful (confirmed by /account probe)."); return; }

  const errorMsg = await page.locator(
    '.errors, .form-error, .form-message--error, [data-error], [role="alert"]'
  ).first().textContent().catch(() => "");

  throw new Error(
    `Login failed: not authenticated after submit. URL: ${probe.url || postUrl}` +
    `${status ? ` | login POST status: ${status}` : ""}` +
    `${errorMsg ? ` | Error: ${errorMsg.trim()}` : ""}`
  );
}
