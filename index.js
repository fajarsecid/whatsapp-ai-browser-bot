import { chromium, errors as playwrightErrors } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import { addChatGptCookiesFromFile } from './src/chatgpt-cookies.js';
import { loadEnvFile } from './src/env.js';
import { splitWhatsAppText } from './src/whatsapp.js';

loadEnvFile();

const IS_MAIN_MODULE = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
const PUBLIC_AI_PREFIX = '.ai';
const WA_AUTH_DIR = process.env.AUTH_DIR || './session';
const DEFAULT_WEB_AI_SERVICE = 'gemini';
const WEB_AI_SERVICE_ARG = IS_MAIN_MODULE ? process.argv[2] || '' : '';
const CHATGPT_USER_AGENT = process.env.CHATGPT_USER_AGENT || '';
let webAiService = normalizeWebAiService(WEB_AI_SERVICE_ARG || process.env.WEB_AI_SERVICE || DEFAULT_WEB_AI_SERVICE);
let browserProfile = resolveBrowserProfile(webAiService);
let browserUserAgent = resolveBrowserUserAgent(webAiService);
const CHATGPT_COOKIE_FILE = process.env.CHATGPT_COOKIE_FILE || './cookie.js';
const AI_MODE_FILE = process.env.AI_MODE_FILE || './ai-modes.json';
const WA_ALLOWED = [];

const CHATGPT_URL = 'https://chatgpt.com';
const GEMINI_URL = 'https://gemini.google.com/app';
const WEB_AI_HEADLESS = parseBooleanEnv(process.env.WEB_AI_HEADLESS ?? process.env.CHATGPT_HEADLESS, true);
const PAIRING_CODE_DELAY_MS = 3000;
const SELECTOR_TIMEOUT_MS = 45_000;
const ANSWER_START_TIMEOUT_MS = 60_000;
const ANSWER_DONE_TIMEOUT_MS = 180_000;
const MAX_CHATGPT_ATTEMPTS = 2;
const WEB_AI_SESSION_IDLE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.WEB_AI_SESSION_IDLE_MS || '', 10) || 5 * 60_000
);
const USE_PAIRING_CODE = !['0', 'false', 'no', 'off'].includes(
  String(process.env.USE_PAIRING_CODE || 'true')
    .trim()
    .toLowerCase()
);
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER || '';

let webAiContext = null;
let webAiPage = null;
let webAiInitPromise = null;
let webAiWarmupPromise = null;
let webAiWarmPage = null;
let waSock = null;
let reconnectTimer = null;
const queue = [];
let isProcessingQueue = false;
let sigintRegistered = false;
const handledMessageIds = new Set();
const webAiSessions = new Map();
const chatModes = loadChatModes();

const AI_MODES = Object.freeze({
  auto: {
    label: 'auto'
  },
  instant: {
    label: 'Instant'
  },
  thinking: {
    label: 'Thinking'
  },
  pro: {
    label: 'Pro'
  }
});

const GEMINI_MODE_BUTTON_SELECTORS = [
  'button[aria-label="Buka pemilih mode"]',
  'button[aria-label*="pemilih mode"]',
  'button[aria-label*="mode"]'
];
const GEMINI_MODE_OPTION_SELECTOR = [
  'button[role="menuitem"]',
  '[role="menuitem"]',
  '[role="option"]',
  'mat-option'
].join(', ');
const CHATGPT_MODE_OPTION_SELECTOR = [
  '[role="menuitemradio"]',
  '[role="menuitem"]',
  '[role="option"]',
  'button'
].join(', ');
const CHATGPT_MODE_OPTION_TESTIDS = Object.freeze({
  instant: 'model-switcher-gpt-5-3',
  thinking: 'model-switcher-gpt-5-5-thinking'
});

const DEFAULT_AI_MODE = normalizeAiMode(process.env.AI_MODE || 'auto') || 'auto';

const logger = P({ level: process.env.LOG_LEVEL || 'silent' });
const keyStoreLogger = P({ level: process.env.LOG_LEVEL || 'fatal' });

async function startWhatsAppClient() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const shouldUsePairingCode = USE_PAIRING_CODE && !state.creds.registered;

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, keyStoreLogger)
    },
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000
  });

  waSock = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    handleConnectionUpdate({ sock, update, shouldUsePairingCode });
  });

  if (shouldUsePairingCode) {
    requestLoginPairingCode(sock).catch((error) => {
      console.error('Gagal membuat pairing code:', error);
    });
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      handleBaileysMessage({ sock, message }).catch((error) => {
        console.error('Message handler failed:', error);
      });
    }
  });

  return sock;
}

function handleConnectionUpdate({ sock, update, shouldUsePairingCode }) {
  const { connection, lastDisconnect, qr } = update;

  if (qr && !shouldUsePairingCode) {
    console.log('Scan QR ini lewat WhatsApp > Linked devices:');
    qrcode.generate(qr, { small: true });
  }

  if (connection === 'connecting') {
    console.log('Menghubungkan ke WhatsApp...');
  }

  if (connection === 'open') {
    console.log(`WhatsApp bot ready: ${sock.user?.id || 'connected'}`);
    warmWebAiBrowser();
  }

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
    console.warn(`Koneksi WhatsApp tertutup. reconnect=${shouldReconnect}`);

    if (shouldReconnect) {
      reconnectTimer = setTimeout(() => {
        startWhatsAppClient().catch((error) => console.error('Gagal reconnect WhatsApp:', error));
      }, 3000);
    } else {
      console.warn(`Session logout. Hapus folder ${WA_AUTH_DIR} lalu pairing ulang jika mau login lagi.`);
    }
  }
}

async function requestLoginPairingCode(sock) {
  await delay(PAIRING_CODE_DELAY_MS);

  const phoneNumber = await resolvePairingPhoneNumber();
  const code = await sock.requestPairingCode(phoneNumber);

  console.log('');
  console.log(`Pairing code: ${formatPairingCode(code)}`);
  console.log('Buka WhatsApp > Linked devices > Link a device > Link with phone number instead.');
  console.log('Masukkan pairing code di atas untuk login bot.');
  console.log('');
}

async function resolvePairingPhoneNumber() {
  const configured = normalizePhoneNumber(PAIRING_PHONE_NUMBER);
  if (configured) return assertValidPairingPhoneNumber(configured);

  if (!input.isTTY) {
    throw new Error('PAIRING_PHONE_NUMBER wajib diisi di environment non-interaktif.');
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question('Masukkan nomor WhatsApp dengan kode negara, contoh 6281234567890: ');
    return assertValidPairingPhoneNumber(normalizePhoneNumber(answer));
  } finally {
    rl.close();
  }
}

async function handleBaileysMessage({ sock, message }) {
  const jid = message.key.remoteJid;
  const messageId = message.key.id;

  if (!jid || !messageId || message.key.fromMe || jid === 'status@broadcast') return;
  if (handledMessageIds.has(messageId)) return;
  handledMessageIds.add(messageId);
  if (handledMessageIds.size > 1000) handledMessageIds.clear();
  if (!isAllowed(message)) return;

  const isGroup = jid.endsWith('@g.us');
  const body = extractText(message);
  const commandReply = handleAiCommand({ jid, body, isGroup });
  if (commandReply) {
    await sendLongText(sock, jid, commandReply, message);
    return;
  }

  const question = resolveQuestion({ body, isGroup });
  if (question === null) return;

  if (!question) {
    await sendLongText(sock, jid, `Kirim pertanyaan setelah ${PUBLIC_AI_PREFIX}.`, message);
    return;
  }

  console.log(`AI request from ${isGroup ? 'group' : 'private'} ${stripWhatsAppSuffix(jid)}.`);
  await sock.readMessages([message.key]).catch(() => {});
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await reactToMessage(sock, jid, message, '⏳');

  queue.push({
    sock,
    jid,
    quotedMessage: message,
    question,
    aiSessionKey: getAiSessionKey({ jid, message, isGroup })
  });
  processQueue().catch((error) => {
    console.error('Queue processor crashed:', error);
  });
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (queue.length > 0) {
      const { sock, jid, quotedMessage, question, aiSessionKey } = queue.shift();
      const activeSock = waSock || sock;

      try {
        const answer = await askWebAi(question, { jid, sessionKey: aiSessionKey });
        await sendLongText(activeSock, jid, answer || `${getWebAiLabel()} tidak mengembalikan jawaban.`, quotedMessage);
        await reactToMessage(activeSock, jid, quotedMessage, '✅');
      } catch (error) {
        console.error('Failed to answer message:', error);
        await sendLongText(activeSock, jid, formatWhatsAppError(error), quotedMessage);
        await reactToMessage(activeSock, jid, quotedMessage, '❌');
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

export async function askChatGPT(question) {
  return askWebAi(question);
}

export async function askWebAi(question, { jid = 'default', sessionKey = jid } = {}) {
  let lastError = null;
  const mode = resolveModeForQuestion(jid, question);
  const aiSessionKey = normalizeAiSessionKey(sessionKey || jid);

  for (let attempt = 1; attempt <= MAX_CHATGPT_ATTEMPTS; attempt += 1) {
    try {
      const page = await getWebAiPage(aiSessionKey);
      if (webAiService === 'gemini') return await askGeminiOnPage(page, question, mode);
      const prompt = buildModePrompt(question, mode);
      return await askChatGPTOnPage(page, prompt, mode);
    } catch (error) {
      lastError = error;

      if (attempt < MAX_CHATGPT_ATTEMPTS && shouldRetryChatGPT(error)) {
        await resetWebAiBrowser();
        continue;
      }

      throw error;
    }
    finally {
      if (webAiService === 'gemini') {
        releaseWebAiSession(aiSessionKey);
      }
    }
  }

  throw lastError;
}

async function getWebAiPage(sessionKey = 'default') {
  if (webAiService === 'gemini') {
    return getGeminiSessionPage(sessionKey);
  }

  return getSharedWebAiPage();
}

async function getSharedWebAiPage() {
  if (!webAiContext && webAiInitPromise) {
    return webAiInitPromise;
  }

  if (!webAiContext) {
    webAiInitPromise = launchWebAiPage();
    try {
      return await webAiInitPromise;
    } finally {
      webAiInitPromise = null;
    }
  }

  if (!webAiPage || webAiPage.isClosed()) {
    webAiPage = webAiContext.pages()[0] || (await webAiContext.newPage());
  }

  return webAiPage;
}

async function getWebAiContext() {
  if (!webAiContext && webAiInitPromise) {
    await webAiInitPromise;
  }

  if (!webAiContext) {
    webAiInitPromise = launchWebAiPage();
    try {
      await webAiInitPromise;
    } finally {
      webAiInitPromise = null;
    }
  }

  return webAiContext;
}

async function launchWebAiPage() {
  webAiContext = await chromium.launchPersistentContext(browserProfile, {
    headless: WEB_AI_HEADLESS,
    ...getWebAiBrowserOptions(),
    ...(browserUserAgent ? { userAgent: browserUserAgent } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  await prepareWebAiContext(webAiContext);
  if (webAiService === 'chatgpt') {
    await loadChatGptCookies(webAiContext);
  }

  webAiContext.on('close', () => {
    clearWebAiSessions();
    webAiContext = null;
    webAiPage = null;
    webAiWarmPage = null;
  });

  webAiPage = webAiContext.pages()[0] || (await webAiContext.newPage());
  return webAiPage;
}

async function getWarmWebAiPage() {
  await getWebAiContext();

  if (!webAiWarmPage || webAiWarmPage.isClosed()) {
    webAiWarmPage = webAiPage && !webAiPage.isClosed() ? webAiPage : await webAiContext.newPage();
  }

  return webAiWarmPage;
}

async function getGeminiSessionPage(sessionKey) {
  const normalizedKey = normalizeAiSessionKey(sessionKey);
  let session = webAiSessions.get(normalizedKey);

  if (session?.page?.isClosed()) {
    clearTimeout(session.cleanupTimer);
    webAiSessions.delete(normalizedKey);
    session = null;
  }

  if (session) {
    clearTimeout(session.cleanupTimer);
    session.busy = true;
    return session.page;
  }

  if (webAiWarmupPromise) {
    await webAiWarmupPromise.catch(() => {});
  }

  await getWebAiContext();

  let page = null;
  if (webAiWarmPage && !webAiWarmPage.isClosed()) {
    page = webAiWarmPage;
    webAiWarmPage = null;
  } else {
    page = await webAiContext.newPage();
  }

  session = {
    page,
    busy: true,
    lastUsedAt: Date.now(),
    cleanupTimer: null
  };
  webAiSessions.set(normalizedKey, session);
  console.log(`Opened ${getWebAiLabel()} session. Active sessions: ${webAiSessions.size}.`);
  return page;
}

function releaseWebAiSession(sessionKey) {
  const session = webAiSessions.get(normalizeAiSessionKey(sessionKey));
  if (!session) return;

  session.busy = false;
  session.lastUsedAt = Date.now();
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    closeIdleWebAiSession(sessionKey).catch((error) => {
      console.warn(`Gagal menutup session idle ${getWebAiLabel()}: ${error.message}`);
    });
  }, WEB_AI_SESSION_IDLE_MS);
  session.cleanupTimer.unref?.();
}

async function closeIdleWebAiSession(sessionKey) {
  const normalizedKey = normalizeAiSessionKey(sessionKey);
  const session = webAiSessions.get(normalizedKey);
  if (!session || session.busy) return;

  if (Date.now() - session.lastUsedAt < WEB_AI_SESSION_IDLE_MS) {
    releaseWebAiSession(normalizedKey);
    return;
  }

  webAiSessions.delete(normalizedKey);
  clearTimeout(session.cleanupTimer);
  await session.page?.close?.().catch(() => {});
  console.log(`Closed idle ${getWebAiLabel()} session. Active sessions: ${webAiSessions.size}.`);
}

function clearWebAiSessions() {
  for (const session of webAiSessions.values()) {
    clearTimeout(session.cleanupTimer);
  }
  webAiSessions.clear();
}

function warmWebAiBrowser() {
  if (webAiWarmupPromise) return webAiWarmupPromise;

  webAiWarmupPromise = (async () => {
    const page = webAiService === 'gemini' ? await getWarmWebAiPage() : await getSharedWebAiPage();

    if (webAiService === 'gemini') {
      await ensureGeminiPageReady(page);
      await findGeminiPrompt(page);
    } else {
      await page.goto(CHATGPT_URL, {
        waitUntil: 'domcontentloaded',
        timeout: SELECTOR_TIMEOUT_MS
      });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await findChatGptPrompt(page);
    }

    console.log(`${getWebAiLabel()} browser ready.`);
  })()
    .catch((error) => {
      console.warn(`Gagal warmup ${getWebAiLabel()}: ${error.message}`);
    })
    .finally(() => {
      webAiWarmupPromise = null;
    });

  return webAiWarmupPromise;
}

async function prepareWebAiContext(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });
}

function getWebAiBrowserOptions() {
  if (/android|mobile/i.test(browserUserAgent)) {
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

async function loadChatGptCookies(context) {
  try {
    const result = await addChatGptCookiesFromFile(context, CHATGPT_COOKIE_FILE);
    if (result.added > 0) {
      console.log(`Loaded ${result.added} ChatGPT cookies from ${CHATGPT_COOKIE_FILE}.`);
    }
  } catch (error) {
    console.warn(`Gagal load cookie ChatGPT dari ${CHATGPT_COOKIE_FILE}: ${error.message}`);
  }
}

async function askChatGPTOnPage(page, question, mode) {
  await ensureChatGptPageReady(page);
  await selectChatGptMode(page, mode);
  const prompt = await findChatGptPrompt(page);
  await fillChatGptPrompt(page, prompt, question);
  await submitChatGptPrompt(page);

  const assistantMessages = await waitForAssistantResponse(page);
  await waitForSelectorOrTimeout(
    assistantMessages.last(),
    '[data-message-author-role="assistant"]',
    SELECTOR_TIMEOUT_MS
  );
  await waitForAssistantTextStable(page, assistantMessages.last(), mode === 'instant' ? 1 : 2);

  const answer = (await assistantMessages.last().innerText({ timeout: SELECTOR_TIMEOUT_MS })).trim();
  if (!answer) {
    throw new Error('Jawaban ChatGPT kosong.');
  }

  return answer;
}

async function ensureChatGptPageReady(page) {
  const hasPreviousAssistant = (await page.locator('[data-message-author-role="assistant"]').count().catch(() => 0)) > 0;
  if (/chatgpt\.com/i.test(page.url()) && !hasPreviousAssistant && (await isChatGptPromptVisible(page))) {
    return;
  }

  await page.goto(CHATGPT_URL, {
    waitUntil: 'domcontentloaded',
    timeout: SELECTOR_TIMEOUT_MS
  });
  await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
  await findChatGptPrompt(page);
}

async function askGeminiOnPage(page, question, mode) {
  await ensureGeminiPageReady(page);

  const prompt = await findGeminiPrompt(page);
  await selectGeminiMode(page, mode);
  const responseLocators = getGeminiResponseLocators(page);
  const beforeCounts = await Promise.all(responseLocators.map((locator) => locator.count().catch(() => 0)));

  await fillChatGptPrompt(page, prompt, question);
  await submitGeminiPrompt(page);

  const response = await waitForGeminiResponse(page, responseLocators, beforeCounts);
  await waitForAssistantTextStable(page, response);

  const answer = (await response.innerText({ timeout: SELECTOR_TIMEOUT_MS })).trim();
  if (!answer) {
    throw new Error('Jawaban Gemini kosong.');
  }

  return cleanupGeminiAnswer(answer);
}

async function ensureGeminiPageReady(page) {
  if (/gemini\.google\.com\/app/i.test(page.url()) && (await isGeminiPromptVisible(page))) {
    return;
  }

  await page.goto(GEMINI_URL, {
    waitUntil: 'domcontentloaded',
    timeout: SELECTOR_TIMEOUT_MS
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

async function findGeminiPrompt(page) {
  const selectors = [
    'rich-textarea [contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    '[contenteditable="true"][aria-label*="Enter"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea'
  ];

  const deadline = Date.now() + SELECTOR_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 500 })) {
          return locator;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (await isGeminiSessionExpired(page)) {
      throw new SessionExpiredError(`${getWebAiLabel()} session expired.`);
    }

    await delay(500);
  }

  const title = await page.title().catch(() => '');
  const url = page.url();
  throw new SelectorTimeoutError(`Gemini prompt input at ${url} (${title || 'no title'})`, SELECTOR_TIMEOUT_MS, lastError);
}

async function submitGeminiPrompt(page) {
  const sendButton = page
    .locator(
      [
        'button[aria-label*="Send"]',
        'button[aria-label*="Submit"]',
        'button:has(mat-icon:has-text("send"))',
        'button:has(mat-icon:has-text("send"))'
      ].join(', ')
    )
    .first();

  if (await sendButton.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await sendButton.click({ timeout: SELECTOR_TIMEOUT_MS });
    return;
  }

  await page.keyboard.press('Enter');
}

async function selectGeminiMode(page, mode) {
  const modeConfig = AI_MODES[mode];
  if (!modeConfig || mode === 'auto') return;

  const modeButton = await findFirstVisibleEnabledLocator(page, GEMINI_MODE_BUTTON_SELECTORS, 15_000);
  if (!modeButton) {
    throw new Error(`Tidak menemukan tombol pemilih mode Gemini untuk memilih ${modeConfig.label}.`);
  }

  const currentMode = normalizeVisibleText(await modeButton.innerText({ timeout: 2_000 }).catch(() => ''));
  if (matchesGeminiMode(currentMode, mode)) return;

  await modeButton.click({ timeout: SELECTOR_TIMEOUT_MS });
  await page.waitForTimeout(500);

  const option = await findGeminiModeOption(page, mode);
  if (!option) {
    const options = await getVisibleGeminiModeOptions(page);
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(
      `Mode Gemini ${modeConfig.label} tidak tersedia di UI. Opsi terlihat: ${options.join(', ') || '-'}`
    );
  }

  await option.click({ timeout: SELECTOR_TIMEOUT_MS, force: true });
  await page.waitForTimeout(750);
}

async function findFirstVisibleEnabledLocator(page, selectors, timeout = SELECTOR_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible({ timeout: 500 }).catch(() => false);
        const enabled = visible ? await candidate.isEnabled({ timeout: 500 }).catch(() => false) : false;
        if (visible && enabled) return candidate;
      }
    }

    await delay(300);
  }

  return null;
}

async function findGeminiModeOption(page, mode) {
  const matcher = getGeminiModeMatcher(mode);
  const options = page.locator(GEMINI_MODE_OPTION_SELECTOR);
  const count = await options.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const visible = await option.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) continue;

    const text = normalizeVisibleText(await option.innerText({ timeout: 2_000 }).catch(() => ''));
    if (matcher.test(text)) return option;
  }

  return null;
}

async function getVisibleGeminiModeOptions(page) {
  const options = page.locator(GEMINI_MODE_OPTION_SELECTOR);
  const count = await options.count().catch(() => 0);
  const texts = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (!(await option.isVisible({ timeout: 300 }).catch(() => false))) continue;
    const text = normalizeVisibleText(await option.innerText({ timeout: 1000 }).catch(() => ''));
    if (text) texts.push(text);
  }

  return texts;
}

function matchesGeminiMode(text, mode) {
  return getGeminiModeMatcher(mode).test(normalizeVisibleText(text));
}

function getGeminiModeMatcher(mode) {
  if (mode === 'instant') return /\b(instant|cepat|fast|flash)\b/i;
  if (mode === 'thinking') return /\b(thinking|think|penalaran|nalar|reasoning|reason)\b/i;
  if (mode === 'pro') return /\b(pro|advanced|deep|mendalam|lanjutan)\b/i;
  return /$a/;
}

function normalizeVisibleText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getGeminiResponseLocators(page) {
  return [
    page.locator('message-content'),
    page.locator('.model-response-text'),
    page.locator('div.markdown'),
    page.locator('[data-test-id*="response"]')
  ];
}

async function waitForGeminiResponse(page, responseLocators, beforeCounts) {
  const deadline = Date.now() + ANSWER_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isGeminiSessionExpired(page)) {
      throw new SessionExpiredError(`${getWebAiLabel()} session expired.`);
    }

    for (let index = 0; index < responseLocators.length; index += 1) {
      const locator = responseLocators[index];
      const count = await locator.count().catch(() => 0);
      if (count > beforeCounts[index]) {
        return locator.nth(count - 1);
      }
    }

    await delay(500);
  }

  throw new SelectorTimeoutError('Gemini response', ANSWER_START_TIMEOUT_MS);
}

async function isGeminiSessionExpired(page) {
  const url = page.url();
  if (/accounts\.google\.com|signin|ServiceLogin/i.test(url)) return true;

  if (await isGeminiPromptVisible(page)) return false;

  const loginButton = page
    .locator('a[href*="accounts.google.com"], button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Login")')
    .first();

  return loginButton.isVisible({ timeout: 2_000 }).catch(() => false);
}

async function isGeminiPromptVisible(page) {
  return page
    .locator('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"], textarea')
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

function cleanupGeminiAnswer(answer) {
  return answer
    .replace(/\n*(Google it|Double-check response|Show thinking|Export to Docs)\s*$/gi, '')
    .trim();
}

async function findChatGptPrompt(page) {
  const selectors = [
    'div#prompt-textarea[contenteditable="true"]',
    '[data-testid="composer"] div#prompt-textarea[contenteditable="true"]',
    '[data-testid="prompt-textarea"][contenteditable="true"]',
    'div[contenteditable="true"].ProseMirror',
    '[contenteditable="true"][role="textbox"]',
    '[role="textbox"][aria-label*="Chat with ChatGPT"]',
    '[role="textbox"][aria-label*="Chat dengan ChatGPT"]',
    '[contenteditable="true"]',
    'textarea:not(.wcDTda_fallbackTextarea)'
  ];

  const deadline = Date.now() + SELECTOR_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 500 })) {
          return locator;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (await isChatGPTSessionExpired(page)) {
      throw new SessionExpiredError();
    }

    await delay(500);
  }

  const title = await page.title().catch(() => '');
  const url = page.url();
  const body = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  if (isChatGptGate({ title, body })) {
    throw new ChatGptGateError();
  }

  throw new SelectorTimeoutError(`ChatGPT prompt input at ${url} (${title || 'no title'})`, SELECTOR_TIMEOUT_MS, lastError);
}

async function isChatGptPromptVisible(page) {
  return page
    .locator(
      [
        'div#prompt-textarea[contenteditable="true"]',
        '[data-testid="composer"] div#prompt-textarea[contenteditable="true"]',
        '[data-testid="prompt-textarea"][contenteditable="true"]',
        'div[contenteditable="true"].ProseMirror',
        '[contenteditable="true"][role="textbox"]',
        '[role="textbox"][aria-label*="Chat with ChatGPT"]',
        '[role="textbox"][aria-label*="Chat dengan ChatGPT"]',
        '[contenteditable="true"]',
        'textarea:not(.wcDTda_fallbackTextarea)'
      ].join(', ')
    )
    .first()
    .isVisible({ timeout: 700 })
    .catch(() => false);
}

async function fillChatGptPrompt(page, prompt, question) {
  await prompt.click({ timeout: SELECTOR_TIMEOUT_MS });

  try {
    await prompt.fill(question, { timeout: SELECTOR_TIMEOUT_MS });
    return;
  } catch {
    await page.keyboard.press('Control+A');
    await page.keyboard.type(question);
  }
}

async function submitChatGptPrompt(page) {
  const sendButton = page
    .locator(
      [
        '[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send"]'
      ].join(', ')
    )
    .first();

  if (await sendButton.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await sendButton.click({ timeout: SELECTOR_TIMEOUT_MS });
    return;
  }

  await page.keyboard.press('Enter');
}

async function selectChatGptMode(page, mode) {
  const modeConfig = AI_MODES[mode];
  if (!modeConfig || mode === 'auto') return;

  const nativeMode = getChatGptNativeMode(mode);
  if (!nativeMode) return;

  const currentMode = await getVisibleChatGptModeButtonText(page);
  if ((mode === 'instant' && currentMode === 'Instant') || (mode !== 'instant' && currentMode === 'Thinking')) {
    return;
  }

  await openChatGptModeMenu(page);
  const option = await findChatGptModeOption(page, mode);
  if (!option) {
    const options = await getVisibleChatGptModeOptions(page);
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(
      `Mode ChatGPT ${nativeMode} tidak tersedia di UI. Opsi terlihat: ${options.join(', ') || '-'}`
    );
  }

  await option.click({ timeout: SELECTOR_TIMEOUT_MS, force: true });
  await page.waitForTimeout(750);
}

async function openChatGptModeMenu(page) {
  if (await clickChatGptTopModelSelector(page)) {
    await waitForChatGptModeOptions(page, 3_000);
    if (await hasVisibleChatGptModeOptions(page)) return;
    await page.keyboard.press('Escape').catch(() => {});
  }

  const clickedModeButton = await clickChatGptModeButton(page, 8_000);
  if (clickedModeButton) {
    await waitForChatGptModeOptions(page, 3_000);
    if (await hasVisibleChatGptModeOptions(page)) return;
    await page.keyboard.press('Escape').catch(() => {});
  } else {
    await openChatGptModeMenuWithShortcut(page);
    await waitForChatGptModeOptions(page, 3_000);
    if (await hasVisibleChatGptModeOptions(page)) return;
    await page.keyboard.press('Escape').catch(() => {});
  }

  if (await clickChatGptTopModelSelector(page)) {
    await waitForChatGptModeOptions(page, 3_000);
    if (await hasVisibleChatGptModeOptions(page)) return;
  }

  if (!(await hasVisibleChatGptModeOptions(page))) {
    throw new Error('Tidak bisa membuka menu mode ChatGPT. Tombol Instant/Thinking tidak terlihat.');
  }
}

async function clickChatGptTopModelSelector(page) {
  const selector = await findFirstVisibleEnabledLocator(
    page,
    ['[data-testid="model-switcher-dropdown-button"]', 'button[aria-label*="Model selector" i]'],
    3_000
  );
  if (!selector) return false;

  await selector.click({ timeout: SELECTOR_TIMEOUT_MS });
  await page.waitForTimeout(500);
  return true;
}

async function clickChatGptModeButton(page, timeout = SELECTOR_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const point = await page
      .evaluate(() => {
        const candidates = [...document.querySelectorAll('button, [role="button"]')]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
            return {
              text,
              visible:
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== 'hidden' &&
                style.display !== 'none',
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            };
          })
          .filter((item) => ['Instant', 'Thinking'].includes(item.text))
          .filter((item) => item.visible)
          .sort((a, b) => b.x - a.x || a.y - b.y);

        const target = candidates[0];
        if (!target) return null;
        return {
          x: Math.round(target.x + target.width / 2),
          y: Math.round(target.y + target.height / 2),
          text: target.text
        };
      })
      .catch(() => null);

    if (point) {
      await page.mouse.click(point.x, point.y);
      return true;
    }

    await delay(300);
  }

  return false;
}

async function getVisibleChatGptModeButtonText(page) {
  return page
    .evaluate(() => {
      const candidates = [...document.querySelectorAll('button, [role="button"]')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
          return {
            text,
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none',
            x: rect.x
          };
        })
        .filter((item) => ['Instant', 'Thinking'].includes(item.text))
        .filter((item) => item.visible)
        .sort((a, b) => b.x - a.x);

      return candidates[0]?.text || '';
    })
    .catch(() => '');
}

async function openChatGptModeMenuWithShortcut(page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+M' : 'Control+M').catch(() => {});
  await page.waitForTimeout(750);
}

async function waitForChatGptModeOptions(page, timeout = 3_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await hasVisibleChatGptModeOptions(page)) return true;
    await delay(200);
  }

  return false;
}

async function findChatGptModeOption(page, mode) {
  const testId = CHATGPT_MODE_OPTION_TESTIDS[mode];
  if (testId) {
    const exactOption = page.locator(`[data-testid="${testId}"]`).first();
    if (await exactOption.isVisible({ timeout: 2_000 }).catch(() => false)) return exactOption;
  }

  const label = mode === 'instant' ? 'Instant' : 'Thinking';
  const options = page.locator(
    [
      `[role="menuitemradio"]:has-text("${label}")`,
      `[role="menuitem"]:has-text("${label}")`,
      `[role="option"]:has-text("${label}")`,
      `button:has-text("${label}")`
    ].join(', ')
  );
  const count = await options.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const visible = await option.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) continue;

    const text = normalizeVisibleText(await option.innerText({ timeout: 1_000 }).catch(() => ''));
    if (text === label) return option;
  }

  return null;
}

async function hasVisibleChatGptModeOptions(page) {
  const instantVisible = await page
    .locator('[data-testid="model-switcher-gpt-5-3"], [role="menuitemradio"]:has-text("Instant")')
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  const thinkingVisible = await page
    .locator('[data-testid="model-switcher-gpt-5-5-thinking"], [role="menuitemradio"]:has-text("Thinking")')
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);

  return instantVisible || thinkingVisible;
}

async function getVisibleChatGptModeOptions(page) {
  const options = page.locator(CHATGPT_MODE_OPTION_SELECTOR);
  const count = await options.count().catch(() => 0);
  const texts = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (!(await option.isVisible({ timeout: 300 }).catch(() => false))) continue;
    const text = normalizeVisibleText(await option.innerText({ timeout: 1000 }).catch(() => ''));
    if (text) texts.push(text);
  }

  return [...new Set(texts)];
}

function getChatGptNativeMode(mode) {
  if (mode === 'instant') return 'GPT-5.3 Instant';
  if (mode === 'thinking' || mode === 'pro') return 'GPT-5.5 Thinking';
  return '';
}

async function waitForAssistantResponse(page) {
  const assistantMessages = page.locator('[data-message-author-role="assistant"]');
  const beforeCount = await assistantMessages.count().catch(() => 0);

  await page
    .waitForFunction(
      (count) => document.querySelectorAll('[data-message-author-role="assistant"]').length > count,
      beforeCount,
      { timeout: ANSWER_START_TIMEOUT_MS }
    )
    .catch(async (error) => {
      if (await isChatGPTSessionExpired(page)) {
        throw new SessionExpiredError();
      }
      throw error;
    });

  return assistantMessages;
}

async function waitForAssistantTextStable(page, locator, stableTarget = 2) {
  const stopButton = page
    .locator('[data-testid="stop-button"], button[aria-label*="Stop"]')
    .first();

  await stopButton.waitFor({ state: 'hidden', timeout: ANSWER_DONE_TIMEOUT_MS }).catch(() => {});

  let previous = '';
  let stableCount = 0;
  const deadline = Date.now() + ANSWER_DONE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const current = (await locator.innerText({ timeout: SELECTOR_TIMEOUT_MS }).catch(() => '')).trim();

    if (current && current === previous) {
      stableCount += 1;
      if (stableCount >= Math.max(1, stableTarget)) return;
    } else {
      previous = current;
      stableCount = 0;
    }

    await delay(1000);
  }
}

async function waitForSelectorOrSessionError(page, locator, selector) {
  try {
    await waitForSelectorOrTimeout(locator, selector);
  } catch (error) {
    if (isTimeoutError(error) && (await isChatGPTSessionExpired(page))) {
      throw new SessionExpiredError();
    }

    throw error;
  }
}

async function waitForSelectorOrTimeout(locator, selector, timeout = SELECTOR_TIMEOUT_MS) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new SelectorTimeoutError(selector, timeout);
    }

    throw error;
  }
}

async function isChatGPTSessionExpired(page) {
  const url = page.url();
  if (/auth|login|signin/i.test(url)) return true;

  const loginButton = page
    .locator('a[href*="auth"], button:has-text("Log in"), button:has-text("Login"), a:has-text("Log in")')
    .first();

  return loginButton.isVisible({ timeout: 2_000 }).catch(() => false);
}

function shouldRetryChatGPT(error) {
  return error instanceof SessionExpiredError || error instanceof SelectorTimeoutError || isTimeoutError(error);
}

async function resetWebAiBrowser() {
  if (!webAiContext) return;

  try {
    clearWebAiSessions();
    await webAiContext.close();
  } catch (error) {
    console.error(`Failed to close ${getWebAiLabel()} browser:`, error);
  } finally {
    webAiContext = null;
    webAiPage = null;
    webAiWarmPage = null;
  }
}

function isAllowed(message) {
  if (WA_ALLOWED.length === 0) return true;

  const ids = [
    message.key?.remoteJid,
    message.key?.participant,
    stripWhatsAppSuffix(message.key?.remoteJid),
    stripWhatsAppSuffix(message.key?.participant)
  ].filter(Boolean);

  return ids.some((id) => WA_ALLOWED.includes(id));
}

function stripWhatsAppSuffix(value) {
  return value ? String(value).replace(/@((s\.)?whatsapp\.net|c\.us|g\.us)$/, '') : '';
}

function extractText(message) {
  const content = unwrapEphemeral(message.message);
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.buttonsResponseMessage?.selectedDisplayText ||
    content?.buttonsResponseMessage?.selectedButtonId ||
    content?.listResponseMessage?.title ||
    ''
  ).trim();
}

function unwrapEphemeral(content) {
  return content?.ephemeralMessage?.message || content?.viewOnceMessage?.message || content;
}

function resolveQuestion({ body, isGroup }) {
  const text = String(body || '').trim();
  if (!text) return null;

  if (isGroup) {
    return text.startsWith(PUBLIC_AI_PREFIX) ? text.slice(PUBLIC_AI_PREFIX.length).trim() : null;
  }

  return text.startsWith(PUBLIC_AI_PREFIX) ? text.slice(PUBLIC_AI_PREFIX.length).trim() : text;
}

function getAiSessionKey({ jid, message, isGroup }) {
  const chatJid = normalizeWhatsAppSessionJid(jid);

  if (isGroup) {
    const participantJid = normalizeWhatsAppSessionJid(message.key?.participant || chatJid);
    return `group:${chatJid}:user:${participantJid}`;
  }

  return `private:${chatJid}`;
}

function normalizeWhatsAppSessionJid(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/:\d+(?=@)/, '');
}

function normalizeAiSessionKey(value) {
  return String(value || 'default')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function handleAiCommand({ jid, body, isGroup }) {
  const text = String(body || '').trim();
  if (!text.startsWith(PUBLIC_AI_PREFIX)) return '';

  const rawArgs = text.slice(PUBLIC_AI_PREFIX.length).trim();
  if (!rawArgs) {
    return formatModeHelp(jid, isGroup);
  }

  const [command, ...rest] = rawArgs.split(/\s+/);
  if (!/^mode$/i.test(command)) return '';

  const requestedMode = rest.join(' ').trim();
  if (!requestedMode) {
    return `AI browser: ${getWebAiLabel()}.\nMode AI sekarang: ${getModeDisplayName(getConfiguredMode(jid))}.\n${getModeBehaviorDescription()}\n\n${formatModeList()}`;
  }

  const mode = normalizeAiMode(requestedMode);
  if (!mode) {
    return `Mode tidak dikenal: ${requestedMode}\n\n${formatModeList()}`;
  }

  const serviceMode = coerceAiModeForService(mode);
  chatModes.set(jid, serviceMode);
  saveChatModes();
  return `Mode AI ${getWebAiLabel()} di chat ini diubah ke: ${getModeDisplayName(serviceMode)}.\n${getModeDescription(serviceMode)}`;
}

function getConfiguredMode(jid) {
  return coerceAiModeForService(chatModes.get(jid) || DEFAULT_AI_MODE);
}

function coerceAiModeForService(mode, service = webAiService) {
  if (service === 'chatgpt' && mode === 'pro') return 'thinking';
  return mode;
}

function resolveModeForQuestion(jid, question) {
  const configuredMode = getConfiguredMode(jid);
  if (configuredMode !== 'auto') return configuredMode;
  return classifyQuestionMode(question);
}

function classifyQuestionMode(question) {
  const text = String(question || '').toLowerCase();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (
    wordCount > 180 ||
    /pro|mendalam|komprehensif|detail banget|riset|audit|arsitektur|rancang|strategi|proposal|dokumen|review kode|code review|produksi|enterprise|skalabilitas|security/i.test(text)
  ) {
    return webAiService === 'gemini' ? 'pro' : 'thinking';
  }

  if (
    wordCount > 55 ||
    /kenapa|mengapa|analisis|nalar|penalaran|hitung|matematika|logika|debug|error|bug|diagnosa|bandingkan|pilih mana|algoritma|optimasi|jelaskan sebab|langkah demi langkah/i.test(text) ||
    /```|=>|==|!=|>=|<=|\bif\b|\bfor\b|\bwhile\b|\bfunction\b|\bclass\b|\bconst\b|\blet\b/i.test(question)
  ) {
    return 'thinking';
  }

  return 'instant';
}

function buildModePrompt(question, mode) {
  const instruction = getModeInstruction(mode);
  return [
    `[Mode AI: ${mode}]`,
    instruction,
    '',
    'Pertanyaan user:',
    question
  ].join('\n');
}

function getModeInstruction(mode) {
  if (mode === 'instant') {
    return 'Mode aktif adalah GPT-5.3 Instant. Jika ditanya model atau mode, jawab bahwa kamu memakai GPT-5.3 Instant. Jawab cepat, ringkas, langsung ke inti, dan jangan terlalu banyak pembukaan.';
  }

  if (mode === 'thinking' || mode === 'pro') {
    return 'Mode aktif adalah GPT-5.5 Thinking. Jika ditanya model atau mode, jawab bahwa kamu memakai GPT-5.5 Thinking. Pikirkan masalah dengan teliti secara internal. Jangan tampilkan chain-of-thought mentah; berikan jawaban akhir, alasan utama, dan langkah praktis.';
  }

  return 'Pilih gaya terbaik berdasarkan pertanyaan: Instant untuk hal mudah, Thinking untuk hal yang butuh penalaran.';
}

function normalizeAiMode(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');

  if (['auto', 'otomatis'].includes(normalized)) return 'auto';
  if (['instant', 'cepat', 'fast', 'flash', 'ringkas', 'simple', 'mudah'].includes(normalized)) return 'instant';
  if (
    ['thinking', 'think', 'penalaran', 'nalar', 'reasoning', 'reason', 'logic', 'logika', 'analisis'].includes(normalized)
  ) {
    return 'thinking';
  }
  if (['pro', 'advanced', 'deep', 'mendalam', 'detail'].includes(normalized)) return 'pro';

  return '';
}

function formatModeHelp(jid, isGroup) {
  const current = getConfiguredMode(jid);
  return [
    `AI browser: ${getWebAiLabel()}.`,
    `Mode AI sekarang: ${getModeDisplayName(current)}.`,
    getModeBehaviorDescription(),
    '',
    formatModeList(),
    '',
    ...getModeCommandHelpLines(),
    '',
    isGroup ? `Di group, tanya AI dengan: ${PUBLIC_AI_PREFIX} pertanyaan` : 'Di private chat, langsung kirim pertanyaan tanpa prefix.'
  ].join('\n');
}

function formatModeList() {
  return getModeListEntries().map(([name, description]) => `${name}: ${description}`).join('\n');
}

function getModeDisplayName(mode) {
  if (webAiService === 'gemini') {
    if (mode === 'instant') return 'cepat';
    if (mode === 'thinking') return 'penalaran';
    if (mode === 'pro') return 'pro';
  }

  return mode;
}

function getModeDescription(mode) {
  if (webAiService === 'gemini') {
    if (mode === 'auto') return 'Bot memilih mode Gemini cepat, penalaran, atau pro dari isi pertanyaan.';
    if (mode === 'instant') return 'Memakai mode Gemini cepat untuk respons cepat.';
    if (mode === 'thinking') return 'Memakai mode Gemini penalaran untuk pertanyaan yang butuh nalar lebih matang.';
    if (mode === 'pro') return 'Memakai mode Gemini Pro untuk pertanyaan berat atau jawaban lebih matang.';
  }

  if (mode === 'auto') return 'Bot memilih mode ChatGPT Instant atau Thinking dari isi pertanyaan.';
  if (mode === 'instant') return 'Memakai mode ChatGPT Instant (GPT-5.3) untuk respons cepat.';
  if (mode === 'thinking' || mode === 'pro') return 'Memakai mode ChatGPT Thinking (GPT-5.5) untuk pertanyaan yang butuh penalaran lebih matang.';
  return '';
}

function getModeListEntries() {
  if (webAiService === 'gemini') {
    return [
      ['auto', getModeDescription('auto')],
      ['cepat / instant', getModeDescription('instant')],
      ['penalaran / thinking', getModeDescription('thinking')],
      ['pro', getModeDescription('pro')]
    ];
  }

  return [
    ['auto', getModeDescription('auto')],
    ['instant', getModeDescription('instant')],
    ['thinking', getModeDescription('thinking')]
  ];
}

function getModeCommandHelpLines() {
  if (webAiService === 'gemini') {
    return [
      `Ubah mode: ${PUBLIC_AI_PREFIX} mode cepat`,
      `${PUBLIC_AI_PREFIX} mode penalaran`,
      `${PUBLIC_AI_PREFIX} mode pro`,
      `${PUBLIC_AI_PREFIX} mode auto`
    ];
  }

  return [`Ubah mode: ${PUBLIC_AI_PREFIX} mode instant`, `${PUBLIC_AI_PREFIX} mode thinking`, `${PUBLIC_AI_PREFIX} mode auto`];
}

function loadChatModes() {
  if (!existsSync(AI_MODE_FILE)) return new Map();

  try {
    const saved = JSON.parse(readFileSync(AI_MODE_FILE, 'utf8'));
    return new Map(
      Object.entries(saved)
        .map(([jid, mode]) => [jid, normalizeAiMode(mode)])
        .filter(([, mode]) => mode)
    );
  } catch (error) {
    console.warn(`Gagal membaca ${AI_MODE_FILE}: ${error.message}`);
    return new Map();
  }
}

function saveChatModes() {
  const payload = Object.fromEntries(chatModes.entries());
  try {
    writeFileSync(AI_MODE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    console.warn(`Gagal menyimpan ${AI_MODE_FILE}: ${error.message}`);
  }
}

async function sendLongText(sock, jid, text, quotedMessage) {
  for (const chunk of splitWhatsAppText(text)) {
    await sock.sendMessage(jid, { text: chunk }, { quoted: quotedMessage });
  }
}

async function reactToMessage(sock, jid, message, text) {
  const key = message?.key;
  if (!key) return;

  await sock
    .sendMessage(jid, {
      react: {
        text,
        key
      }
    })
    .catch((error) => {
      console.warn(`Gagal react ke pesan WhatsApp: ${error.message}`);
    });
}

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function assertValidPairingPhoneNumber(phoneNumber) {
  if (!/^[1-9]\d{6,14}$/.test(phoneNumber)) {
    throw new Error('Nomor WhatsApp tidak valid. Pakai format internasional tanpa + atau spasi, contoh 6281234567890.');
  }

  return phoneNumber;
}

function formatPairingCode(code) {
  return String(code || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1-');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeWebAiService(value) {
  const service = String(value || 'gemini')
    .trim()
    .toLowerCase();

  if (!['chatgpt', 'gemini'].includes(service)) {
    throw new Error('WEB_AI_SERVICE harus "chatgpt" atau "gemini" untuk bot browser ini.');
  }

  return service;
}

function getWebAiLabel() {
  return webAiService === 'gemini' ? 'Gemini' : 'ChatGPT';
}

function getModeBehaviorDescription() {
  if (webAiService === 'gemini') {
    return 'Di Gemini, mode ini memilih menu mode asli di UI jika tersedia.';
  }

  return 'Di ChatGPT, mode ini memakai dua mode saja: instant atau thinking. Jika menu UI tidak kebuka, bot tetap lanjut lewat instruksi prompt.';
}

function resolveBrowserProfile(service) {
  return process.env.BROWSER_PROFILE || (service === 'gemini' ? './browser-profile-gemini' : './browser-profile');
}

function resolveBrowserUserAgent(service) {
  return process.env.BROWSER_USER_AGENT || (service === 'chatgpt' ? CHATGPT_USER_AGENT : '');
}

function setWebAiService(service) {
  webAiService = normalizeWebAiService(service);
  browserProfile = resolveBrowserProfile(webAiService);
  browserUserAgent = resolveBrowserUserAgent(webAiService);
}

async function configureStartupWebAiService(serviceOverride = '') {
  const explicitService = serviceOverride || WEB_AI_SERVICE_ARG || process.env.WEB_AI_SERVICE || '';

  if (explicitService) {
    setWebAiService(explicitService);
    printSelectedWebAiService();
    return;
  }

  if (!input.isTTY) {
    printSelectedWebAiService('default');
    return;
  }

  const rl = createInterface({ input, output });

  try {
    console.log('Pilih mode AI browser:');
    console.log('1. Gemini');
    console.log('2. ChatGPT');

    while (true) {
      const answer = await rl.question('Mode saat start bot [1/Gemini, 2/ChatGPT] (default: Gemini): ');
      const selected = parseWebAiServiceChoice(answer);

      if (selected) {
        setWebAiService(selected);
        printSelectedWebAiService();
        return;
      }

      console.log('Pilihan tidak dikenal. Ketik 1/Gemini atau 2/ChatGPT.');
    }
  } finally {
    rl.close();
  }
}

function parseWebAiServiceChoice(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (!normalized || ['1', 'g', 'gemini'].includes(normalized)) return 'gemini';
  if (['2', 'c', 'chat', 'chatgpt', 'gpt'].includes(normalized)) return 'chatgpt';
  return '';
}

function printSelectedWebAiService(reason = '') {
  const suffix = reason === 'default' ? ' default non-interaktif' : '';
  console.log(`Mode AI browser${suffix}: ${getWebAiLabel()} (profile: ${browserProfile}).`);
}

function formatWhatsAppError(error) {
  if (error instanceof ChatGptGateError) {
    return 'ChatGPT belum bisa dibuka: browser tertahan di halaman security check / "Just a moment...". Cookie perlu di-refresh atau login manual ulang sampai halaman chat terbuka.';
  }

  if (error instanceof SessionExpiredError) {
    const loginScript = webAiService === 'gemini' ? 'npm run login:gemini' : 'npm run login:chatgpt';
    return `Sesi ${getWebAiLabel()} belum login atau kedaluwarsa. Jalankan ${loginScript}, pastikan halaman chat terbuka, lalu start bot lagi.`;
  }

  if (error instanceof SelectorTimeoutError || isTimeoutError(error)) {
    return `Error: timeout menunggu selector ${getWebAiLabel()}. ${error.message}`;
  }

  return `Error: ${error.message || `Gagal meminta jawaban ke ${getWebAiLabel()}.`}`;
}

function isTimeoutError(error) {
  return error instanceof playwrightErrors.TimeoutError || /timeout/i.test(error?.message || '');
}

function isChatGptGate({ title = '', body = '' } = {}) {
  return /just a moment|checking your browser|cloudflare/i.test(`${title}\n${body}`);
}

class SelectorTimeoutError extends Error {
  constructor(selector, timeout, cause) {
    super(`Selector ${selector} tidak muncul dalam ${timeout}ms.`);
    this.name = 'SelectorTimeoutError';
    this.cause = cause;
  }
}

class SessionExpiredError extends Error {
  constructor(message = 'Web AI session expired.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

class ChatGptGateError extends Error {
  constructor() {
    super('ChatGPT security gate is blocking the browser session.');
    this.name = 'ChatGptGateError';
  }
}

export async function startBot(options = {}) {
  await configureStartupWebAiService(options.webAiService);

  if (!sigintRegistered) {
    process.once('SIGINT', shutdown);
    sigintRegistered = true;
  }

  return startWhatsAppClient();
}

async function shutdown() {
  clearTimeout(reconnectTimer);
  await resetWebAiBrowser();

  try {
    waSock?.end?.(new Error('Process interrupted.'));
    waSock?.ws?.close?.();
  } catch {
    // Closing the websocket is best-effort; never logout on Ctrl+C.
  }

  process.exit(0);
}

if (IS_MAIN_MODULE) {
  startBot().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
