import { chromium } from 'playwright';
import { resolveBrowserProfile } from '../src/browser-profile.js';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const profile = resolveBrowserProfile('gemini');
const modeButtonSelectorList = [
  'button[aria-label="Buka pemilih mode"]',
  'button[aria-label*="pemilih mode"]',
  'button[aria-label*="mode"]',
  'button:has-text("Pro")'
];
const modeButtonSelectors = modeButtonSelectorList.join(', ');

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
  await page
    .locator('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"], textarea')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => {});

  const matchingButtons = await page.locator(modeButtonSelectors).evaluateAll((elements) =>
    elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        index,
        tag: element.tagName.toLowerCase(),
        aria: element.getAttribute('aria-label') || '',
        text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
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

  let modeButton = null;
  for (const selector of modeButtonSelectorList) {
    const count = await page.locator(selector).count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = page.locator(selector).nth(index);
      const visible = await candidate.isVisible({ timeout: 1000 }).catch(() => false);
      const enabled = visible ? await candidate.isEnabled({ timeout: 1000 }).catch(() => false) : false;
      if (visible && enabled) {
        modeButton = candidate;
        break;
      }
    }
    if (modeButton) break;
  }

  const buttonVisible = Boolean(modeButton);
  const buttonEnabled = Boolean(modeButton);
  const buttonText = modeButton ? await modeButton.innerText({ timeout: 2_000 }).catch(() => '') : '';

  if (buttonVisible && buttonEnabled) {
    await modeButton.click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
  }

  const candidates = await page
    .locator('button, [role="menuitem"], [role="option"], mat-option, mat-selection-list mat-list-option, a')
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
          const aria = element.getAttribute('aria-label') || '';
          const role = element.getAttribute('role') || '';
          return {
            tag: element.tagName.toLowerCase(),
            role,
            aria,
            text,
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
        .filter((item) => /mode|model|flash|pro|thinking|reason|nalar|cepat|lanjutan|deep|gemini/i.test(`${item.text} ${item.aria}`))
        .slice(0, 80)
    );

  console.log(
    JSON.stringify(
      {
        url: page.url(),
        title: await page.title().catch(() => ''),
        buttonVisible,
        buttonEnabled,
        buttonText,
        matchingButtons,
        candidates
      },
      null,
      2
    )
  );
} catch (error) {
  console.error('Gagal inspect mode Gemini:', error.message);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}
