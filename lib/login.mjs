export async function loginIfNeeded(page, { base, email, password }) {
  // Skip if creds not provided
  if (!base || !email || !password) return;

  // Go to login
  await page.goto(`${base}/account/login`, { waitUntil: "domcontentloaded" });
  console.log("[login] on page:", page.url());

  // Best-effort cookie banners — short timeout so missing buttons fail fast (not 30s each)
  await page.getByRole("button", { name: /accept|agree|ok/i }).first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('button:has-text("Accept")').first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('button:has-text("I Accept")').first().click({ timeout: 2000 }).catch(() => {});

  // If already logged in, Shopify redirects to /account (but NOT /account/login)
  const isLoginPage = (u) => /\/account\/login/.test(u);
  const isAccountPage = (u) => /\/account(\/(?!login)|$)/.test(u);

  if (isAccountPage(page.url()) && !isLoginPage(page.url())) {
    const logout = await page.locator('a[href*="/account/logout"]').first().isVisible().catch(() => false);
    if (logout) {
      console.log("[login] already logged in, skipping.");
      return;
    }
  }

  // Scope to the actual login form (avoid recover/forgot forms)
  const form = page.locator('form[action*="/account/login"]').first();

  const emailInput = form.locator(
    'input[name="customer[email]"], #CustomerEmail, #customer_email, input[type="email"]'
  ).first();

  const passInput = form.locator(
    'input[name="customer[password]"], #CustomerPassword, #customer_password, input[type="password"]'
  ).first();

  // Confirm form fields are present before filling
  const emailVisible = await emailInput.isVisible().catch(() => false);
  const passVisible  = await passInput.isVisible().catch(() => false);
  console.log("[login] form fields visible — email:", emailVisible, "password:", passVisible);

  if (!emailVisible || !passVisible) {
    throw new Error("Login failed: could not find email/password fields on login page.");
  }

  // Fill within the form scope to avoid strict-mode collisions
  await emailInput.fill(email, { timeout: 15000 });
  await passInput.fill(password, { timeout: 15000 });
  console.log("[login] credentials filled, submitting...");

  // Submit: try three approaches in order
  // 1) Native DOM form.submit() — bypasses any JS click/submit handlers that block bots
  const submitted = await page.evaluate(() => {
    const f = document.querySelector('form[action*="/account/login"]');
    if (f) { f.submit(); return true; }
    return false;
  }).catch(() => false);

  if (!submitted) {
    // 2) Keyboard Enter on the password field
    await passInput.press("Enter").catch(() => {});
  }

  // Wait for navigation after submit
  await page.waitForLoadState("networkidle");
  const postUrl = page.url();
  console.log("[login] post-submit url:", postUrl);

  // Success: landed on /account (not /account/login)
  const onAccount = isAccountPage(postUrl) && !isLoginPage(postUrl);
  const hasLogout  = await page.locator('a[href*="/account/logout"]').first().isVisible().catch(() => false);

  console.log("[login] onAccount:", onAccount, "hasLogout:", hasLogout);

  if (!onAccount && !hasLogout) {
    // Check if error message is shown on the login page
    const errorMsg = await page.locator('.errors, .form-error, [data-error]').first().textContent().catch(() => "");
    throw new Error(
      `Login failed: still on login page after submit. URL: ${postUrl}${errorMsg ? ` | Error: ${errorMsg.trim()}` : ""}`
    );
  }

  console.log("[login] login successful.");
}
