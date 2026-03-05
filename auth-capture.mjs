import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.SUPPLIER_BASE || "https://core.co.za";
const OUT_DIR = process.env.AUTH_OUT_DIR || ".auth";
const OUT_FILE = process.env.AUTH_FILE || "state.json";

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Launch headed so you can solve captcha
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-ZA",
    timezoneId: "Africa/Johannesburg",
  });

  const page = await context.newPage();

  const loginUrl = `${BASE.replace(/\/+$/, "")}/account/login`;
  const accountUrl = `${BASE.replace(/\/+$/, "")}/account`;

  console.log("[auth] open:", loginUrl);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });

  console.log("[auth] Login manually in the opened window.");
  console.log("[auth] IMPORTANT: complete the captcha challenge until it says you’re verified.");
  console.log("[auth] When you are on /account (not /account/login), press ENTER here.");

  await waitForEnter();

  // Verify login by forcing /account
  await page.goto(accountUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForLoadState("networkidle").catch(() => {});

  const url = page.url();
  console.log("[auth] now at:", url);

  if (url.includes("/account/login")) {
    console.error("[auth] Not logged in yet (redirected back to login).");
    console.error("[auth] Try again: solve captcha, then ensure you see account page, then press ENTER.");
    process.exit(2);
  }

  const outPath = path.join(OUT_DIR, OUT_FILE);
  await context.storageState({ path: outPath });
  console.log("[auth] saved:", outPath);

  await browser.close();
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});