import "dotenv/config";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromium.use(StealthPlugin());
import { loginIfNeeded } from "./lib/login.mjs";
import fs from "fs";

const { SUPPLIER_BASE, DEALER_EMAIL, DEALER_PASSWORD, COLLECTION_URLS, COLLECTION_URL } = process.env;

const url = (COLLECTION_URLS || COLLECTION_URL || "").split(",")[0].trim();
if (!url) throw new Error("No collection URL in env");

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
});
await ctx.addInitScript(() => {
  // Hide automation flags
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  // Fake Chrome runtime (missing in headless)
  window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  // Fake plugins array (headless has 0, real Chrome has some)
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
  // Languages
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
});
const page = await ctx.newPage();

console.log("[debug] logging in...");
await loginIfNeeded(page, { base: SUPPLIER_BASE, email: DEALER_EMAIL, password: DEALER_PASSWORD });
console.log("[debug] logged in, current url:", page.url());

console.log("[debug] navigating to collection:", url);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(2000);

console.log("[debug] final url:", page.url());

// Screenshot
await page.screenshot({ path: "debug-collection.png", fullPage: true });
console.log("[debug] screenshot saved: debug-collection.png");

// Dump all hrefs containing /products/
const links = await page.evaluate(() =>
  Array.from(document.querySelectorAll("a"))
    .map(a => a.getAttribute("href"))
    .filter(h => h && h.includes("/products/"))
);
console.log(`[debug] product hrefs found: ${links.length}`);
links.slice(0, 10).forEach(l => console.log("  ", l));

// Dump ALL anchor hrefs (first 30) to see what's on the page
const allLinks = await page.evaluate(() =>
  Array.from(document.querySelectorAll("a"))
    .map(a => a.getAttribute("href"))
    .filter(Boolean)
    .slice(0, 30)
);
console.log(`\n[debug] all anchor hrefs (first 30):`);
allLinks.forEach(l => console.log("  ", l));

// Dump page title and a snippet of the body text
const title = await page.title();
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
console.log("\n[debug] page title:", title);
console.log("[debug] body text snippet:\n", bodyText);

// Save full HTML for inspection
const html = await page.content();
fs.writeFileSync("debug-collection.html", html);
console.log("[debug] full HTML saved: debug-collection.html");

await browser.close();
