export async function loginIfNeeded(page, { base, email, password }) {
  // Skip if creds not provided
  if (!base || !email || !password) return;

  const loginUrl = `${base.replace(/\/+$/, "")}/account/login`;
  const accountUrl = `${base.replace(/\/+$/, "")}/account`;

  // Go to login
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  console.log("[login] on page:", page.url());

  // Best-effort cookie banners — short timeout so missing buttons fail fast
  await page.getByRole("button", { name: /accept|agree|ok/i }).first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('button:has-text("Accept")').first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('button:has-text("I Accept")').first().click({ timeout: 2000 }).catch(() => {});

  // Helpers
  const isLoginPage = (u) => /\/account\/login/.test(u);
  const isAccountPage = (u) => /\/account(\/(?!login)|$)/.test(u);

  async function hasLogoutMarker(p) {
    return await p.locator('a[href*="/account/logout"]').first().isVisible().catch(() => false);
  }

  async function probeAccount() {
    // If logged in, /account should NOT end up at /account/login
    await page.goto(accountUrl, { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    const u = page.url();
    const logout = await hasLogoutMarker(page);
    return { url: u, ok: (isAccountPage(u) && !isLoginPage(u)) || logout, logout };
  }

  // If already logged in, Shopify redirects to /account (but NOT /account/login)
  if (isAccountPage(page.url()) && !isLoginPage(page.url())) {
    const logout = await hasLogoutMarker(page);
    if (logout) {
      console.log("[login] already logged in, skipping.");
      return;
    }
  }

  // Scope to the actual login form (avoid recover/forgot forms)
  // Some themes use "/account/login" exactly, others include query params; match broadly.
  const form = page.locator('form[action*="/account/login"], form[action="/account/login"]').first();

  const emailInput = form.locator(
    'input[name="customer[email]"], #CustomerEmail, #customer_email, input[type="email"], input[name="email"]'
  ).first();

  const passInput = form.locator(
    'input[name="customer[password]"], #CustomerPassword, #customer_password, input[type="password"], input[name="password"]'
  ).first();

  const emailVisible = await emailInput.isVisible().catch(() => false);
  const passVisible = await passInput.isVisible().catch(() => false);
  console.log("[login] form fields visible — email:", emailVisible, "password:", passVisible);

  if (!emailVisible || !passVisible) {
    throw new Error("Login failed: could not find email/password fields on login page.");
  }

  await emailInput.fill(email, { timeout: 15000 });
  await passInput.fill(password, { timeout: 15000 });
  console.log("[login] credentials filled, submitting...");

  // We wait for the /account/login POST response.
  // Shopify success is typically 302/303 redirect.
  const waitLoginResponse = page.waitForResponse(
    (r) => {
      const url = r.url();
      return url.includes("/account/login") && (r.request().method() === "POST" || r.request().method() === "post");
    },
    { timeout: 20000 }
  ).catch(() => null);

  // Submit in the most theme-compatible way:
  // 1) click submit button if present
  // 2) else press Enter
  // 3) else form.submit()
  const submitBtn = form.locator(
    'button[type="submit"], input[type="submit"], button[name="commit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")'
  ).first();

  const submitVisible = await submitBtn.isVisible().catch(() => false);

  if (submitVisible) {
    await submitBtn.click({ timeout: 15000 }).catch(() => {});
  } else {
    await passInput.press("Enter").catch(() => {});
    // if Enter didn't trigger, fall back to form.submit()
    await page.evaluate(() => {
      const f = document.querySelector('form[action*="/account/login"], form[action="/account/login"]');
      if (f) f.submit();
    }).catch(() => {});
  }

  // Wait for response + settle.
  const resp = await waitLoginResponse;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);

  const postUrl = page.url();
  const status = resp ? resp.status() : null;
  console.log("[login] post-submit url:", postUrl, "loginRespStatus:", status);

  // Primary success signals
  const onAccountNow = isAccountPage(postUrl) && !isLoginPage(postUrl);
  const hasLogoutNow = await hasLogoutMarker(page);
  console.log("[login] onAccount:", onAccountNow, "hasLogout:", hasLogoutNow);

  if (onAccountNow || hasLogoutNow) {
    console.log("[login] login successful.");
    return;
  }

  // If still on login page, probe /account to confirm (session may still be set)
  const probe = await probeAccount();
  console.log("[login] probe /account:", probe.url, "ok:", probe.ok, "logout:", probe.logout);

  if (probe.ok) {
    console.log("[login] login successful (confirmed by /account probe).");
    return;
  }

  // Pull a better error message (Shopify themes vary)
  const errorMsg = await page.locator(
    '.errors, .form-error, .form-message--error, [data-error], [role="alert"]'
  ).first().textContent().catch(() => "");

  throw new Error(
    `Login failed: not authenticated after submit. URL: ${probe.url || postUrl}` +
      `${status ? ` | login POST status: ${status}` : ""}` +
      `${errorMsg ? ` | Error: ${errorMsg.trim()}` : ""}`
  );
}