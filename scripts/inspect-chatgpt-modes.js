import { chromium } from 'playwright';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const profile = process.env.BROWSER_PROFILE || './browser-profile';
const userAgent = process.env.BROWSER_USER_AGENT || process.env.CHATGPT_USER_AGENT || '';
const screenshotPath = process.env.SCREENSHOT_PATH || '';

const modelButtonSelectorList = [
  '[data-testid="model-switcher-dropdown-button"]',
  'button[aria-label*="model" i]',
  'button[aria-label*="Model" i]',
  'button:has-text("Instant")',
  '[role="button"]:has-text("Instant")',
  'button:has-text("Thinking")',
  '[role="button"]:has-text("Thinking")',
  'button:has-text("Standard")',
  '[role="button"]:has-text("Standard")',
  'button:has-text("Standar")',
  '[role="button"]:has-text("Standar")',
  'button:has-text("Extended")',
  '[role="button"]:has-text("Extended")',
  'button:has-text("Matang")',
  '[role="button"]:has-text("Matang")',
  'button:has-text("Terbaru")',
  '[role="button"]:has-text("Terbaru")',
  'button:has-text("Latest")',
  '[role="button"]:has-text("Latest")',
  'button:has-text("GPT")',
  'button:has-text("ChatGPT")'
];
const modelButtonSelectors = modelButtonSelectorList.join(', ');

let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    ...(userAgent ? { userAgent } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://chatgpt.com', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page
    .locator('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => {});

  const matchingButtons = await page.locator(modelButtonSelectors).evaluateAll((elements) =>
    elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = element.getAttribute('aria-label') || '';
      const role = element.getAttribute('role') || '';
      const testid = element.getAttribute('data-testid') || '';
      return {
        index,
        tag: element.tagName.toLowerCase(),
        role,
        testid,
        aria,
        text,
        disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none',
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      };
    })
  );

  let modelButton = null;
  for (const selector of modelButtonSelectorList) {
    const count = await page.locator(selector).count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = page.locator(selector).nth(index);
      const visible = await candidate.isVisible({ timeout: 1000 }).catch(() => false);
      const enabled = visible ? await candidate.isEnabled({ timeout: 1000 }).catch(() => false) : false;
      if (visible && enabled) {
        modelButton = candidate;
        break;
      }
    }
    if (modelButton) break;
  }

  const buttonVisible = Boolean(modelButton);
  const buttonText = modelButton ? await modelButton.innerText({ timeout: 2_000 }).catch(() => '') : '';
  const buttonAria = modelButton ? await modelButton.getAttribute('aria-label').catch(() => '') : '';

  if (modelButton) {
    await modelButton.click({ timeout: 10_000 });
    await page.waitForTimeout(1200);
  }

  const instantButton = page.locator('button:has-text("Instant")').first();
  const clickedInstant = await instantButton.isVisible({ timeout: 1500 }).catch(() => false);
  if (clickedInstant) {
    await instantButton.click({ timeout: 10_000 });
    await page.waitForTimeout(1200);
  }

  const menuText = await page
    .locator('[role="menu"], [role="listbox"], [cmdk-list], [data-radix-popper-content-wrapper]')
    .evaluateAll((elements) =>
      elements
        .map((element) => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    )
    .catch(() => []);

  const candidates = await page
    .locator('button, [role="menuitem"], [role="option"], [cmdk-item], a, div, span')
    .evaluateAll((elements) =>
      elements
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
          const aria = element.getAttribute('aria-label') || '';
          const role = element.getAttribute('role') || '';
          const testid = element.getAttribute('data-testid') || '';
          return {
            index,
            tag: element.tagName.toLowerCase(),
            role,
            testid,
            aria,
            text,
            disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none',
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          };
        })
        .filter((item) => item.visible && (item.text || item.aria))
        .filter((item) => item.w >= 16 && item.h >= 12)
        .filter((item) =>
          /gpt|chatgpt|model|reason|thinking|think|fast|instant|pro|deep|auto|legacy|default|quick|cepat|nalar|smart|terbaru|kecerdasan|standar|matang|upaya/i.test(
            `${item.text} ${item.aria}`
          )
        )
        .slice(0, 120)
    );

  console.log(
    JSON.stringify(
      {
        url: page.url(),
        title: await page.title().catch(() => ''),
        buttonVisible,
        buttonText,
        buttonAria,
        clickedInstant,
        matchingButtons,
        menuText,
        candidates
      },
      null,
      2
    )
  );

  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: false });
  }
} catch (error) {
  console.error('Gagal inspect mode ChatGPT:', error.message);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}
