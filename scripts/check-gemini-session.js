import { chromium } from 'playwright';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const profile = process.env.BROWSER_PROFILE || './browser-profile-gemini';

let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://gemini.google.com/app', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  const result = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    prompt: await page
      .locator('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"], textarea')
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false),
    signIn: await page
      .locator('a[href*="accounts.google.com"], button:has-text("Sign in"), a:has-text("Sign in")')
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
  };

  console.log(JSON.stringify(result, null, 2));
  console.log(result.prompt ? 'Gemini session looks usable.' : 'Gemini prompt is not visible.');
} catch (error) {
  console.error('Gagal cek session Gemini:', error.message);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}
