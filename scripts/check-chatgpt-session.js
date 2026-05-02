import { chromium } from 'playwright';
import { resolveBrowserProfile } from '../src/browser-profile.js';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const BROWSER_PROFILE = resolveBrowserProfile('chatgpt');
const CHATGPT_URL = 'https://chatgpt.com/';
const CHATGPT_HEADLESS = parseBooleanEnv(process.env.CHATGPT_HEADLESS, true);
const CHATGPT_USER_AGENT = process.env.CHATGPT_USER_AGENT || '';

let context;

try {
  context = await chromium.launchPersistentContext(BROWSER_PROFILE, {
    headless: CHATGPT_HEADLESS,
    ...getBrowserOptions(),
    ...(CHATGPT_USER_AGENT ? { userAgent: CHATGPT_USER_AGENT } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  await prepareContext(context);

  const page = context.pages()[0] || (await context.newPage());

  await page.goto(CHATGPT_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  const signals = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    userAgent: await page.evaluate(() => navigator.userAgent).catch(() => ''),
    webdriver: await page.evaluate(() => navigator.webdriver).catch(() => null),
    promptTextarea: await isVisible(page, '#prompt-textarea'),
    contentEditable: await isVisible(page, '[contenteditable="true"]'),
    textarea: await isVisible(page, 'textarea'),
    loginButton: await isVisible(page, 'button:has-text("Log in"), a:has-text("Log in"), button:has-text("Login"), a:has-text("Login")'),
    cloudflareGate:
      /cloudflare|just a moment|checking your browser/i.test(await page.title().catch(() => '')) ||
      /cloudflare|just a moment|checking your browser/i.test(await page.locator('body').innerText({ timeout: 3_000 }).catch(() => ''))
  };

  console.log(JSON.stringify(signals, null, 2));

  if (signals.promptTextarea || signals.contentEditable || signals.textarea) {
    console.log('ChatGPT session looks usable.');
  } else if (signals.loginButton || /auth|login|signin/i.test(signals.url)) {
    console.log('ChatGPT session is not logged in.');
  } else if (signals.cloudflareGate) {
    console.log('ChatGPT is blocked by a browser/security gate.');
  } else {
    console.log('ChatGPT page loaded, but no known prompt input was visible.');
  }
} catch (error) {
  console.error('Gagal cek session ChatGPT:', error.message);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}

async function prepareContext(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });
}

async function isVisible(page, selector) {
  return page
    .locator(selector)
    .first()
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function getBrowserOptions() {
  if (/android|mobile/i.test(CHATGPT_USER_AGENT)) {
    return {
      viewport: { width: 393, height: 851 },
      deviceScaleFactor: 2.75,
      isMobile: true,
      hasTouch: true
    };
  }

  return {
    viewport: { width: 1280, height: 900 }
  };
}
