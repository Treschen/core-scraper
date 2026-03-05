import fs from "node:fs";

export async function loginIfNeeded(page, { base, email, password, authStatePath = "/app/.auth/state.json" }) {
  const baseUrl = (base || "").replace(/\/+$/, "");
  const loginUrl = `${baseUrl}/account/login`;
  const accountUrl = `${baseUrl}/account`;

  // Helper: confirm logged in
  const hasLogoutMarker = async () =>
    page.locator('a[href*="/account/logout"]').first().isVisible().catch(() => false);

  const probeAccount = async () => {
    await page.goto(accountUrl, { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    const u = page.url();
    const ok = (u.includes("/account") && !u.includes("/account/login")) || (await hasLogoutMarker());
    return { ok, url: u };
  };

  // 1) If storageState exists, try probe immediately (fast path)
  if (fs.existsSync(authStatePath)) {
    const probe = await probeAccount();
    if (probe.ok) {
      console.log("[login] storageState session valid:", probe.url);
      return;
    }
    console.log("[login] storageState exists but session invalid/expired:", probe.url);
  }

  // 2) Optional cookie injection fallback (if you have cookies.json)
  const cookiesPath = "/app/.auth/cookies.json";
  if (fs.existsSync(cookiesPath)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
      if (Array.isArray(cookies) && cookies.length) {
        await page.context().addCookies(cookies);
        console.log(`[login] injected ${cookies.length} cookies from ${cookiesPath}`);

        const probe = await probeAccount();
        if (probe.ok) {
          console.log("[login] cookie session valid:", probe.url);
          // persist storageState for future runs
          await page.context().storageState({ path: authStatePath }).catch(() => {});
          console.log(`[login] saved storageState to ${authStatePath}`);
          return;
        }
        console.log("[login] cookies injected but session is invalid/expired, url:", probe.url);
      }
    } catch (e) {
      console.log("[login] failed to read cookies.json:", e.message);
    }
  }

  // 3) Form login (will fail on Core if hCaptcha is present)
  // Only attempt if creds provided
  if (!email || !password) {
    console.log("[login] no DEALER_EMAIL/DEALER_PASSWORD provided — skipping form login.");
    return;
  }

  console.log("[login] cookie login unavailable, attempting form login...");
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  console.log("[login] on page:", page.url());

  // Detect Shopify hCaptcha / challenge
  const html = await page.content().catch(() => "");
  const lc = html.toLowerCase();
  const hasCaptcha = lc.includes("hcaptcha") || lc.includes("shopify-hcaptcha") || lc.includes("captcha-provider");
  if (hasCaptcha) {
    throw new Error(
      "Shopify hCaptcha detected on login. Headless form login will not work. " +
      "Create /app/.auth/state.json using a one-time headed login (auth capture), then rerun the container."
    );
  }

  // Best-effort cookie banner buttons
  await page.getByRole("button", { name: /accept|agree|ok/i }).first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('button:has-text("Accept")').first().click({ timeout: 2000 }).catch(() => {});

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

  if (!emailVisible || !passVisible) throw new Error("Login failed: could not find email/password fields on login page.");

  await emailInput.fill(email, { timeout: 15000 });
  await passInput.fill(password, { timeout: 15000 });
  console.log("[login] credentials filled, submitting...");

  const submitBtn = form.locator('button[type="submit"], input[type="submit"], button[name="commit"]').first();
  await submitBtn.click({ timeout: 15000 }).catch(async () => {
    await passInput.press("Enter").catch(() => {});
  });

  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(250);

  // Confirm login
  const probe = await probeAccount();
  if (!probe.ok) {
    throw new Error(`Login failed: not authenticated after submit. URL: ${probe.url}`);
  }

  console.log("[login] login successful:", probe.url);

  // Persist state for future runs
  await page.context().storageState({ path: authStatePath }).catch(() => {});
  console.log(`[login] saved storageState to ${authStatePath}`);
}