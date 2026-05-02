import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import { resolveBrowserProfile } from './src/browser-profile.js';
import { loadEnvFile } from './src/env.js';

loadEnvFile();

const TARGETS = Object.freeze({
  chatgpt: {
    label: 'ChatGPT',
    url: 'https://chatgpt.com'
  },
  gemini: {
    label: 'Gemini',
    url: 'https://gemini.google.com/app'
  }
});

const targetName = normalizeTarget(process.argv[2] || process.env.WEB_AI_SERVICE || 'chatgpt');
const target = TARGETS[targetName];
const BROWSER_PROFILE = resolveBrowserProfile(targetName);
const LOGIN_HEADLESS = parseBooleanEnv(process.env.LOGIN_HEADLESS, false);
const BROWSER_USER_AGENT = process.env.BROWSER_USER_AGENT || '';

const rl = createInterface({ input, output });

try {
  const context = await chromium.launchPersistentContext(BROWSER_PROFILE, {
    headless: LOGIN_HEADLESS,
    viewport: { width: 1280, height: 900 },
    ...(BROWSER_USER_AGENT ? { userAgent: BROWSER_USER_AGENT } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(target.url, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });

  console.log(`Login ke ${target.label} di browser yang terbuka.`);
  await rl.question('Setelah login berhasil, tekan ENTER di terminal untuk menyimpan session...');

  await context.close();
  console.log(`Session tersimpan di ${BROWSER_PROFILE}.`);
} catch (error) {
  console.error(`Gagal login ${target.label}:`, error);
  process.exitCode = 1;
} finally {
  rl.close();
}

function normalizeTarget(value) {
  const normalized = String(value || 'chatgpt')
    .trim()
    .toLowerCase();

  if (!Object.hasOwn(TARGETS, normalized)) {
    throw new Error('Target login harus "chatgpt" atau "gemini".');
  }

  return normalized;
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}
