const { chromium } = require("playwright");

const MIRROR_ID      = process.env.MIRROR_ID;
const TARGET_URL     = process.env.TARGET_URL;
const CALLBACK_URL   = process.env.CALLBACK_URL;
const CALLBACK_TOKEN = process.env.CALLBACK_TOKEN;

const HARD_TIMEOUT_MS = 90_000;

async function postCallback(body) {
  const res = await fetch(CALLBACK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-token": CALLBACK_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text().catch(() => "");
  console.log(`callback HTTP ${res.status}: ${txt.slice(0, 200)}`);
  if (!res.ok) process.exit(1);
}

(async () => {
  if (!MIRROR_ID || !TARGET_URL || !CALLBACK_URL || !CALLBACK_TOKEN) {
    console.error("missing required env vars");
    process.exit(2);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
    });
    const page = await ctx.newPage();
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });

    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const html = await page.content();
    const finalUrl = page.url();
    console.log(`rendered ${html.length} bytes from ${finalUrl}`);

    await postCallback({
      mirror_id: MIRROR_ID,
      status: "ok",
      html,
      final_url: finalUrl,
    });
  } catch (e) {
    console.error("render failed:", e.message);
    await postCallback({
      mirror_id: MIRROR_ID,
      status: "error",
      error_message: String(e.message || e).slice(0, 400),
    }).catch(() => {});
    process.exit(1);
  } finally {
    try { await browser?.close(); } catch (_) { /* ignore */ }
  }
})().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});

setTimeout(() => {
  console.error(`hard timeout ${HARD_TIMEOUT_MS}ms`);
  process.exit(124);
}, HARD_TIMEOUT_MS).unref();
