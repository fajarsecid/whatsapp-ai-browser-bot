import { chromium } from 'playwright';
import { DEFAULT_CHATGPT_COOKIE_FILE, addChatGptCookiesFromFile } from '../src/chatgpt-cookies.js';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const BROWSER_PROFILE = process.env.BROWSER_PROFILE || './browser-profile';
const COOKIE_FILE = process.argv[2] || process.env.CHATGPT_COOKIE_FILE || DEFAULT_CHATGPT_COOKIE_FILE;
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

  const result = await addChatGptCookiesFromFile(context, COOKIE_FILE);
  const chatgptCookies = await context.cookies('https://chatgpt.com/');

  console.log(`Imported ${result.added} cookies from ${COOKIE_FILE} into ${BROWSER_PROFILE}.`);
  console.log(`Profile now has ${chatgptCookies.length} cookies visible for https://chatgpt.com/.`);
} catch (error) {
  console.error('Gagal import cookie ChatGPT:', error.message);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

async function prepareContext(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });
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
