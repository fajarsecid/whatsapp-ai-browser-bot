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
import { resolveBrowserProfile as resolveServiceBrowserProfile } from './src/browser-profile.js';
import { loadEnvFile } from './src/env.js';
import { splitWhatsAppText } from './src/whatsapp.js';

loadEnvFile();

const IS_MAIN_MODULE = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
const PUBLIC_AI_PREFIX = '.ai';
const WA_AUTH_DIR = process.env.AUTH_DIR || './session';
const DEFAULT_WEB_AI_SERVICE = 'gemini';
const WEB_AI_SERVICE_ARG = IS_MAIN_MODULE ? process.argv[2] || '' : '';
const CHATGPT_USER_AGENT = process.env.CHATGPT_USER_AGENT || '';
const AI_MODE_FILE = process.env.AI_MODE_FILE || './ai-modes.json';
const AI_SERVICE_FILE = process.env.AI_SERVICE_FILE || './ai-services.json';
const WA_ALLOWED = [];
const savedAiServices = loadAiServices();
const startupWebAiService =
  savedAiServices.defaultService ||
  normalizeWebAiService(WEB_AI_SERVICE_ARG || process.env.WEB_AI_SERVICE || DEFAULT_WEB_AI_SERVICE);
let webAiService = startupWebAiService;
let browserProfile = resolveBrowserProfile(webAiService);
let browserUserAgent = resolveBrowserUserAgent(webAiService);

const CHATGPT_URL = 'https://chatgpt.com';
const GEMINI_URL = 'https://gemini.google.com/app';
const WEB_AI_HEADLESS = parseBooleanEnv(process.env.WEB_AI_HEADLESS ?? process.env.CHATGPT_HEADLESS, true);
const PAIRING_CODE_DELAY_MS = 3000;
const SELECTOR_TIMEOUT_MS = 45_000;
const ANSWER_START_TIMEOUT_MS = 60_000;
const ANSWER_DONE_TIMEOUT_MS = 180_000;
const ANSWER_STABLE_INTERVAL_MS = Math.max(
  150,
  Number.parseInt(process.env.ANSWER_STABLE_INTERVAL_MS || '', 10) || 300
);
const ANSWER_STABLE_CHECKS = Math.max(1, Number.parseInt(process.env.ANSWER_STABLE_CHECKS || '', 10) || 2);
const MAX_WEB_AI_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.WEB_AI_MAX_ATTEMPTS || process.env.MAX_CHATGPT_ATTEMPTS || '', 10) || 2
);
const MAX_QUEUE_PER_CHAT = Math.max(1, Number.parseInt(process.env.MAX_QUEUE_PER_CHAT || '', 10) || 2);
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

let waSock = null;
let reconnectTimer = null;
const queue = [];
let isProcessingQueue = false;
let sigintRegistered = false;
const handledMessageIds = new Set();
const webAiStates = new Map();
const queueCountsBySession = new Map();
const chatServices = savedAiServices.chatServices;
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
const GENERATION_BUSY_SELECTORS = [
  '[data-testid="stop-button"]',
  'button[aria-label*="Stop" i]',
  'button[aria-label*="Cancel" i]',
  'button[aria-label*="Berhenti" i]',
  'button[aria-label*="Hentikan" i]',
  'button:has(mat-icon:has-text("stop"))',
  '[aria-busy="true"]',
  '[data-is-streaming="true"]',
  '[data-streaming="true"]'
];

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
  const commandReply = await handleAiCommand({ jid, body, isGroup, message });
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

  const aiSessionKey = getAiSessionKey({ jid, message, isGroup });
  const service = getConfiguredService(jid);
  const queuedForChat = getQueueCount(aiSessionKey);
  if (queuedForChat >= MAX_QUEUE_PER_CHAT) {
    await sendLongText(
      sock,
      jid,
      `Antrean chat ini masih penuh (${queuedForChat}/${MAX_QUEUE_PER_CHAT}). Tunggu balasan sebelumnya selesai, lalu kirim lagi.`,
      message
    );
    return;
  }

  console.log(`AI request from ${isGroup ? 'group' : 'private'} ${stripWhatsAppSuffix(jid)} via ${getWebAiLabel(service)}.`);
  await Promise.allSettled([
    sock.readMessages([message.key]),
    sock.sendPresenceUpdate('composing', jid),
    reactToMessage(sock, jid, message, '⏳')
  ]);

  incrementQueueCount(aiSessionKey);
  queue.push({
    sock,
    jid,
    quotedMessage: message,
    question,
    aiSessionKey,
    service
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
      const { sock, jid, quotedMessage, question, aiSessionKey, service } = queue.shift();
      const activeSock = waSock || sock;
      let retryNoticeSent = false;

      try {
        const answer = await askWebAi(question, {
          jid,
          sessionKey: aiSessionKey,
          service,
          onRetry: async () => {
            if (retryNoticeSent) return;
            retryNoticeSent = true;
            await sendLongText(
              activeSock,
              jid,
              `${getWebAiLabel(service)} lambat atau macet. Saya reload browser lalu coba sekali lagi.`,
              quotedMessage
            );
          }
        });
        await sendLongText(activeSock, jid, answer || `${getWebAiLabel(service)} tidak mengembalikan jawaban.`, quotedMessage);
        reactToMessage(activeSock, jid, quotedMessage, '✅');
      } catch (error) {
        console.error('Failed to answer message:', error);
        await sendLongText(activeSock, jid, formatWhatsAppError(error, service), quotedMessage);
        reactToMessage(activeSock, jid, quotedMessage, '❌');
      } finally {
        decrementQueueCount(aiSessionKey);
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

export async function askChatGPT(question) {
  return askWebAi(question);
}

export async function askWebAi(
  question,
  { jid = 'default', sessionKey = jid, service = getConfiguredService(jid), onRetry = null } = {}
) {
  let lastError = null;
  const aiService = normalizeWebAiService(service);
  const mode = resolveModeForQuestion(jid, question, aiService);
  const aiSessionKey = normalizeAiSessionKey(sessionKey || jid);

  for (let attempt = 1; attempt <= MAX_WEB_AI_ATTEMPTS; attempt += 1) {
    try {
      const page = await getWebAiPage(aiService, aiSessionKey);
      if (aiService === 'gemini') return await askGeminiOnPage(page, question, mode);
      const prompt = buildModePrompt(question, mode);
      return await askChatGPTOnPage(page, prompt, mode);
    } catch (error) {
      lastError = error;

      if (attempt < MAX_WEB_AI_ATTEMPTS && shouldRetryWebAi(error)) {
        await onRetry?.({ attempt, error, service: aiService });
        await resetWebAiBrowser(aiService);
        continue;
      }

      if (shouldResetWebAiAfterError(error)) {
        await resetWebAiBrowser(aiService);
      }

      throw error;
    }
    finally {
      if (aiService === 'gemini') {
        releaseWebAiSession(aiService, aiSessionKey);
      }
    }
  }

  throw lastError;
}

async function getWebAiPage(service, sessionKey = 'default') {
  const aiService = normalizeWebAiService(service);
  if (aiService === 'gemini') {
    return getGeminiSessionPage(aiService, sessionKey);
  }

  return getSharedWebAiPage(aiService);
}

async function getSharedWebAiPage(service) {
  const state = getWebAiState(service);
  if (!state.context && state.initPromise) {
    return state.initPromise;
  }

  if (!state.context) {
    const initPromise = launchWebAiPage(service);
    state.initPromise = initPromise;
    try {
      return await initPromise;
    } finally {
      if (state.initPromise === initPromise) state.initPromise = null;
    }
  }

  if (!state.page || state.page.isClosed()) {
    state.page = state.context.pages()[0] || (await state.context.newPage());
  }

  return state.page;
}

async function getWebAiContext(service) {
  const state = getWebAiState(service);
  if (!state.context && state.initPromise) {
    await state.initPromise;
  }

  if (!state.context) {
    const initPromise = launchWebAiPage(service);
    state.initPromise = initPromise;
    try {
      await initPromise;
    } finally {
      if (state.initPromise === initPromise) state.initPromise = null;
    }
  }

  return state.context;
}

async function launchWebAiPage(service) {
  const aiService = normalizeWebAiService(service);
  const state = getWebAiState(aiService);
  state.profile = resolveBrowserProfile(aiService);
  state.userAgent = resolveBrowserUserAgent(aiService);

  let context;
  try {
    context = await chromium.launchPersistentContext(state.profile, {
      headless: WEB_AI_HEADLESS,
      ...getWebAiBrowserOptions(aiService),
      ...(state.userAgent ? { userAgent: state.userAgent } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
  } catch (error) {
    if (isBrowserProfileInUseError(error)) {
      throw new BrowserProfileInUseError(aiService, state.profile, error);
    }

    throw error;
  }

  state.context = context;
  await prepareWebAiContext(context);

  context.on('close', () => {
    clearWebAiSessions(aiService);
    if (state.context === context) {
      state.context = null;
      state.page = null;
      state.warmPage = null;
    }
  });

  state.page = context.pages()[0] || (await context.newPage());
  return state.page;
}

async function getWarmWebAiPage(service) {
  const state = getWebAiState(service);
  await getWebAiContext(service);

  if (!state.warmPage || state.warmPage.isClosed()) {
    state.warmPage = state.page && !state.page.isClosed() ? state.page : await state.context.newPage();
  }

  return state.warmPage;
}

async function getGeminiSessionPage(service, sessionKey) {
  const state = getWebAiState(service);
  const normalizedKey = normalizeAiSessionKey(sessionKey);
  let session = state.sessions.get(normalizedKey);

  if (session?.page?.isClosed()) {
    clearTimeout(session.cleanupTimer);
    state.sessions.delete(normalizedKey);
    session = null;
  }

  if (session) {
    clearTimeout(session.cleanupTimer);
    session.busy = true;
    return session.page;
  }

  if (state.warmupPromise) {
    await state.warmupPromise.catch(() => {});
  }

  await getWebAiContext(service);

  let page = null;
  if (state.warmPage && !state.warmPage.isClosed()) {
    page = state.warmPage;
    state.warmPage = null;
  } else {
    page = await state.context.newPage();
  }

  session = {
    page,
    busy: true,
    lastUsedAt: Date.now(),
    cleanupTimer: null
  };
  state.sessions.set(normalizedKey, session);
  console.log(`Opened ${getWebAiLabel(service)} session. Active sessions: ${state.sessions.size}.`);
  return page;
}

function releaseWebAiSession(service, sessionKey) {
  const state = getWebAiState(service);
  const session = state.sessions.get(normalizeAiSessionKey(sessionKey));
  if (!session) return;

  session.busy = false;
  session.lastUsedAt = Date.now();
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    closeIdleWebAiSession(service, sessionKey).catch((error) => {
      console.warn(`Gagal menutup session idle ${getWebAiLabel(service)}: ${error.message}`);
    });
  }, WEB_AI_SESSION_IDLE_MS);
  session.cleanupTimer.unref?.();
}

async function closeIdleWebAiSession(service, sessionKey) {
  const state = getWebAiState(service);
  const normalizedKey = normalizeAiSessionKey(sessionKey);
  const session = state.sessions.get(normalizedKey);
  if (!session || session.busy) return;

  if (Date.now() - session.lastUsedAt < WEB_AI_SESSION_IDLE_MS) {
    releaseWebAiSession(service, normalizedKey);
    return;
  }

  state.sessions.delete(normalizedKey);
  clearTimeout(session.cleanupTimer);
  await session.page?.close?.().catch(() => {});
  console.log(`Closed idle ${getWebAiLabel(service)} session. Active sessions: ${state.sessions.size}.`);
}

function clearWebAiSessions(service) {
  const state = getWebAiState(service);
  for (const session of state.sessions.values()) {
    clearTimeout(session.cleanupTimer);
  }
  state.sessions.clear();
}

function warmWebAiBrowser(service = webAiService) {
  const warmupService = normalizeWebAiService(service);
  const state = getWebAiState(warmupService);
  if (state.warmupPromise) return state.warmupPromise;

  const warmupLabel = getWebAiLabel(warmupService);
  const warmupPromise = (async () => {
    const page = warmupService === 'gemini' ? await getWarmWebAiPage(warmupService) : await getSharedWebAiPage(warmupService);

    if (warmupService === 'gemini') {
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

    console.log(`${warmupLabel} browser ready.`);
  })()
    .catch((error) => {
      console.warn(`Gagal warmup ${warmupLabel}: ${error.message}`);
      if (shouldResetWebAiAfterError(error)) {
        return resetWebAiBrowser(warmupService);
      }
    })
    .finally(() => {
      if (state.warmupPromise === warmupPromise) {
        state.warmupPromise = null;
      }
    });

  state.warmupPromise = warmupPromise;
  return warmupPromise;
}

function getWebAiState(service = webAiService) {
  const aiService = normalizeWebAiService(service);
  let state = webAiStates.get(aiService);
  if (!state) {
    state = {
      service: aiService,
      context: null,
      page: null,
      initPromise: null,
      warmupPromise: null,
      warmPage: null,
      sessions: new Map(),
      profile: resolveBrowserProfile(aiService),
      userAgent: resolveBrowserUserAgent(aiService)
    };
    webAiStates.set(aiService, state);
  }

  return state;
}

function getKnownWebAiServices() {
  return [...new Set([webAiService, ...chatServices.values(), ...webAiStates.keys(), 'gemini', 'chatgpt'])];
}

async function prepareWebAiContext(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });
}

function getWebAiBrowserOptions(service = webAiService) {
  const userAgent = resolveBrowserUserAgent(service);
  if (/android|mobile/i.test(userAgent)) {
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
  await waitForAssistantTextStable(page, assistantMessages.last(), mode === 'instant' ? 1 : ANSWER_STABLE_CHECKS);

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
  await waitForAssistantTextStable(page, response, mode === 'instant' ? 1 : ANSWER_STABLE_CHECKS);

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
      throw new SessionExpiredError(`${getWebAiLabel('gemini')} session expired.`);
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
      throw new SessionExpiredError(`${getWebAiLabel('gemini')} session expired.`);
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

async function waitForAssistantTextStable(page, locator, stableTarget = ANSWER_STABLE_CHECKS) {
  let previous = '';
  let stableCount = 0;
  const deadline = Date.now() + ANSWER_DONE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const [currentText, isBusy] = await Promise.all([
      locator.innerText({ timeout: Math.max(1000, ANSWER_STABLE_INTERVAL_MS * 2) }).catch(() => ''),
      isGenerationBusyVisible(page)
    ]);
    const current = currentText.trim();

    if (!isBusy && current && current === previous) {
      stableCount += 1;
      if (stableCount >= Math.max(1, stableTarget)) return;
    } else {
      previous = current;
      stableCount = 0;
    }

    await delay(ANSWER_STABLE_INTERVAL_MS);
  }
}

async function isGenerationBusyVisible(page) {
  for (const selector of GENERATION_BUSY_SELECTORS) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 10);

    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible({ timeout: 100 }).catch(() => false)) {
        return true;
      }
    }
  }

  return false;
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

function shouldRetryWebAi(error) {
  return error instanceof SessionExpiredError || error instanceof SelectorTimeoutError || isTimeoutError(error);
}

function shouldResetWebAiAfterError(error) {
  return error instanceof ChatGptGateError || error instanceof BrowserProfileInUseError;
}

async function resetWebAiBrowser(service = webAiService) {
  const aiService = normalizeWebAiService(service);
  const state = getWebAiState(aiService);
  const context = state.context;

  try {
    clearWebAiSessions(aiService);
    if (context) {
      await context.close();
    }
  } catch (error) {
    console.error(`Failed to close ${getWebAiLabel(aiService)} browser:`, error);
  } finally {
    state.initPromise = null;
    state.warmupPromise = null;
    state.context = null;
    state.page = null;
    state.warmPage = null;
  }
}

async function resetAllWebAiBrowsers() {
  for (const service of getKnownWebAiServices()) {
    await resetWebAiBrowser(service);
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

function getQueueCount(sessionKey) {
  return queueCountsBySession.get(normalizeAiSessionKey(sessionKey)) || 0;
}

function incrementQueueCount(sessionKey) {
  const key = normalizeAiSessionKey(sessionKey);
  queueCountsBySession.set(key, getQueueCount(key) + 1);
}

function decrementQueueCount(sessionKey) {
  const key = normalizeAiSessionKey(sessionKey);
  const nextCount = Math.max(0, getQueueCount(key) - 1);
  if (nextCount === 0) {
    queueCountsBySession.delete(key);
  } else {
    queueCountsBySession.set(key, nextCount);
  }
}

async function handleAiCommand({ jid, body, isGroup, message }) {
  const text = String(body || '').trim();
  if (!text.startsWith(PUBLIC_AI_PREFIX)) return '';

  const rawArgs = text.slice(PUBLIC_AI_PREFIX.length).trim();
  if (!rawArgs) {
    return formatModeHelp(jid, isGroup);
  }

  const [command, ...rest] = rawArgs.split(/\s+/);
  if (/^(status|info)$/i.test(command)) {
    return formatAiStatus({ jid, message, isGroup });
  }

  if (!/^(mode|modr)$/i.test(command)) return '';

  const requestedMode = rest.join(' ').trim();
  if (!requestedMode) {
    return formatModeHelp(jid, isGroup);
  }

  const globalServiceMatch = requestedMode.match(/^(global|semua|all|default)\s+(.+)$/i);
  if (globalServiceMatch) {
    const requestedDefaultService = normalizeWebAiSwitchService(globalServiceMatch[2]);
    if (requestedDefaultService) {
      return switchDefaultWebAiServiceFromChat(requestedDefaultService);
    }
  }

  if (/^(default|bawaan)$/i.test(requestedMode)) {
    return clearChatWebAiService(jid);
  }

  const requestedService = normalizeWebAiSwitchService(requestedMode);
  if (requestedService) {
    return switchChatWebAiService(jid, requestedService);
  }

  const mode = normalizeAiMode(requestedMode);
  if (!mode) {
    return `Mode tidak dikenal: ${requestedMode}\n\n${formatModeList(getConfiguredService(jid))}\n\n${formatServiceSwitchHelp()}`;
  }

  const service = getConfiguredService(jid);
  const serviceMode = coerceAiModeForService(mode, service);
  chatModes.set(jid, serviceMode);
  saveChatModes();
  return `Mode AI ${getWebAiLabel(service)} di chat ini diubah ke: ${getModeDisplayName(serviceMode, service)}.\n${getModeDescription(serviceMode, service)}`;
}

function switchChatWebAiService(jid, service) {
  const currentService = getConfiguredService(jid);
  const nextService = normalizeWebAiService(service);

  if (nextService === currentService) {
    return `Chat ini sudah memakai ${getWebAiLabel(nextService)}.\n${formatServiceSwitchHelp()}`;
  }

  chatServices.set(jid, nextService);
  saveAiServices();
  warmWebAiBrowser(nextService);

  return `AI browser chat ini diganti ke ${getWebAiLabel(nextService)}.\nPertanyaan berikutnya dari chat ini akan memakai ${getWebAiLabel(nextService)}.`;
}

function clearChatWebAiService(jid) {
  if (!chatServices.has(jid)) {
    return `Chat ini sudah memakai default: ${getWebAiLabel(webAiService)}.`;
  }

  chatServices.delete(jid);
  saveAiServices();
  warmWebAiBrowser(webAiService);
  return `AI browser chat ini dikembalikan ke default: ${getWebAiLabel(webAiService)}.`;
}

function switchDefaultWebAiServiceFromChat(service) {
  const nextService = normalizeWebAiService(service);

  if (nextService === webAiService) {
    return `Default AI browser sudah ${getWebAiLabel(nextService)}.\n${formatServiceSwitchHelp()}`;
  }

  setWebAiService(nextService, { save: true });
  warmWebAiBrowser(nextService);
  return `Default AI browser diganti ke ${getWebAiLabel(nextService)}.\nChat yang belum punya pilihan sendiri akan memakai ${getWebAiLabel(nextService)}.`;
}

function getConfiguredService(jid = 'default') {
  return chatServices.get(jid) || webAiService;
}

function getConfiguredMode(jid, service = getConfiguredService(jid)) {
  return coerceAiModeForService(chatModes.get(jid) || DEFAULT_AI_MODE, service);
}

function coerceAiModeForService(mode, service = webAiService) {
  if (service === 'chatgpt' && mode === 'pro') return 'thinking';
  return mode;
}

function resolveModeForQuestion(jid, question, service = getConfiguredService(jid)) {
  const configuredMode = getConfiguredMode(jid, service);
  if (configuredMode !== 'auto') return configuredMode;
  return classifyQuestionMode(question, service);
}

function classifyQuestionMode(question, service = webAiService) {
  const text = String(question || '').toLowerCase();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (
    wordCount > 180 ||
    /pro|mendalam|komprehensif|detail banget|riset|audit|arsitektur|rancang|strategi|proposal|dokumen|review kode|code review|produksi|enterprise|skalabilitas|security/i.test(text)
  ) {
    return service === 'gemini' ? 'pro' : 'thinking';
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

function normalizeWebAiSwitchService(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  if (['gemini', 'google', 'google gemini'].includes(normalized)) return 'gemini';
  if (['chatgpt', 'chat gpt', 'gpt', 'openai', 'open ai'].includes(normalized)) return 'chatgpt';
  return '';
}

function formatModeHelp(jid, isGroup) {
  const service = getConfiguredService(jid);
  const current = getConfiguredMode(jid, service);
  return [
    `AI browser chat ini: ${getWebAiLabel(service)}${chatServices.has(jid) ? '' : ' (default)'}.`,
    `Mode AI sekarang: ${getModeDisplayName(current, service)}.`,
    getModeBehaviorDescription(service),
    '',
    formatModeList(service),
    '',
    formatServiceSwitchHelp(),
    '',
    ...getModeCommandHelpLines(service),
    '',
    isGroup ? `Di group, tanya AI dengan: ${PUBLIC_AI_PREFIX} pertanyaan` : 'Di private chat, langsung kirim pertanyaan tanpa prefix.'
  ].join('\n');
}

function formatAiStatus({ jid, message, isGroup }) {
  const service = getConfiguredService(jid);
  const mode = getConfiguredMode(jid, service);
  const sessionKey = message ? getAiSessionKey({ jid, message, isGroup }) : normalizeWhatsAppSessionJid(jid);
  const serviceSource = chatServices.has(jid) ? 'chat ini' : 'default';
  const state = getWebAiState(service);
  const activeTotal = [...queueCountsBySession.values()].reduce((total, count) => total + count, 0);

  return [
    `AI browser chat ini: ${getWebAiLabel(service)} (${serviceSource}).`,
    `Default AI browser: ${getWebAiLabel(webAiService)}.`,
    `Mode chat ini: ${getModeDisplayName(mode, service)}.`,
    `Browser ${getWebAiLabel(service)}: ${formatWebAiStateStatus(state)}.`,
    `Session aktif ${getWebAiLabel(service)}: ${state.sessions.size}.`,
    `Antrean chat ini: ${getQueueCount(sessionKey)}/${MAX_QUEUE_PER_CHAT}.`,
    `Antrean total: ${activeTotal}.`,
    `Retry AI macet: maksimal ${MAX_WEB_AI_ATTEMPTS} kali.`
  ].join('\n');
}

function formatWebAiStateStatus(state) {
  if (state.warmupPromise || state.initPromise) return 'sedang disiapkan';
  if (state.context) return 'siap';
  return 'belum dibuka';
}

function formatModeList(service = webAiService) {
  return getModeListEntries(service).map(([name, description]) => `${name}: ${description}`).join('\n');
}

function formatServiceSwitchHelp() {
  return [
    `Switch AI chat ini: ${PUBLIC_AI_PREFIX} mode gemini / ${PUBLIC_AI_PREFIX} mode chatgpt`,
    `Balik ke default: ${PUBLIC_AI_PREFIX} mode default`,
    `Ubah default semua chat: ${PUBLIC_AI_PREFIX} mode global gemini / ${PUBLIC_AI_PREFIX} mode global chatgpt`,
    `Cek status: ${PUBLIC_AI_PREFIX} status`
  ].join('\n');
}

function getModeDisplayName(mode, service = webAiService) {
  if (service === 'gemini') {
    if (mode === 'instant') return 'cepat';
    if (mode === 'thinking') return 'penalaran';
    if (mode === 'pro') return 'pro';
  }

  return mode;
}

function getModeDescription(mode, service = webAiService) {
  if (service === 'gemini') {
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

function getModeListEntries(service = webAiService) {
  if (service === 'gemini') {
    return [
      ['auto', getModeDescription('auto', service)],
      ['cepat / instant', getModeDescription('instant', service)],
      ['penalaran / thinking', getModeDescription('thinking', service)],
      ['pro', getModeDescription('pro', service)]
    ];
  }

  return [
    ['auto', getModeDescription('auto', service)],
    ['instant', getModeDescription('instant', service)],
    ['thinking', getModeDescription('thinking', service)]
  ];
}

function getModeCommandHelpLines(service = webAiService) {
  if (service === 'gemini') {
    return [
      `Ubah mode: ${PUBLIC_AI_PREFIX} mode cepat`,
      `${PUBLIC_AI_PREFIX} mode penalaran`,
      `${PUBLIC_AI_PREFIX} mode pro`,
      `${PUBLIC_AI_PREFIX} mode auto`
    ];
  }

  return [`Ubah mode: ${PUBLIC_AI_PREFIX} mode instant`, `${PUBLIC_AI_PREFIX} mode thinking`, `${PUBLIC_AI_PREFIX} mode auto`];
}

function loadAiServices() {
  if (!existsSync(AI_SERVICE_FILE)) {
    return { defaultService: '', chatServices: new Map() };
  }

  try {
    const saved = JSON.parse(readFileSync(AI_SERVICE_FILE, 'utf8'));
    const defaultService = normalizeWebAiSwitchService(saved?.defaultService || saved?.default || '');
    const chatEntries = Object.entries(saved?.chats || saved?.chatServices || {})
      .map(([jid, service]) => [jid, normalizeWebAiSwitchService(service)])
      .filter(([, service]) => service);

    return {
      defaultService,
      chatServices: new Map(chatEntries)
    };
  } catch (error) {
    console.warn(`Gagal membaca ${AI_SERVICE_FILE}: ${error.message}`);
    return { defaultService: '', chatServices: new Map() };
  }
}

function saveAiServices() {
  const payload = {
    defaultService: webAiService,
    chats: Object.fromEntries(chatServices.entries())
  };

  try {
    writeFileSync(AI_SERVICE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    console.warn(`Gagal menyimpan ${AI_SERVICE_FILE}: ${error.message}`);
  }
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
    await sock.sendMessage(jid, { text: chunk, linkPreview: null }, { quoted: quotedMessage });
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

function getWebAiLabel(service = webAiService) {
  return service === 'gemini' ? 'Gemini' : 'ChatGPT';
}

function getModeBehaviorDescription(service = webAiService) {
  if (service === 'gemini') {
    return 'Di Gemini, mode ini memilih menu mode asli di UI jika tersedia.';
  }

  return 'Di ChatGPT, mode ini memakai dua mode saja: instant atau thinking. Jika menu UI tidak kebuka, bot tetap lanjut lewat instruksi prompt.';
}

function resolveBrowserProfile(service) {
  return resolveServiceBrowserProfile(service, { legacyService: startupWebAiService });
}

function resolveBrowserUserAgent(service) {
  return process.env.BROWSER_USER_AGENT || (service === 'chatgpt' ? CHATGPT_USER_AGENT : '');
}

function setWebAiService(service, { save = false } = {}) {
  webAiService = normalizeWebAiService(service);
  browserProfile = resolveBrowserProfile(webAiService);
  browserUserAgent = resolveBrowserUserAgent(webAiService);
  if (save) saveAiServices();
}

async function configureStartupWebAiService(serviceOverride = '') {
  const overrideService = normalizeWebAiSwitchService(serviceOverride);
  if (overrideService) {
    setWebAiService(overrideService, { save: true });
    printSelectedWebAiService('override');
    return;
  }

  if (savedAiServices.defaultService) {
    setWebAiService(savedAiServices.defaultService);
    printSelectedWebAiService('saved');
    return;
  }

  const explicitService = WEB_AI_SERVICE_ARG || process.env.WEB_AI_SERVICE || '';
  if (explicitService) {
    setWebAiService(explicitService, { save: true });
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
        setWebAiService(selected, { save: true });
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
  const suffix =
    reason === 'default'
      ? ' default non-interaktif'
      : reason === 'saved'
        ? ' tersimpan'
        : reason === 'override'
          ? ' override'
          : '';
  console.log(`Mode AI browser${suffix}: ${getWebAiLabel()} (profile: ${browserProfile}).`);
}

function formatWhatsAppError(error, service = webAiService) {
  const label = getWebAiLabel(service);
  if (error instanceof ChatGptGateError) {
    return 'ChatGPT belum bisa dibuka: browser tertahan di halaman security check / "Just a moment...". Login manual ulang sampai halaman chat terbuka, lalu start bot lagi.';
  }

  if (error instanceof BrowserProfileInUseError) {
    return `Browser ${label} belum bisa dibuka karena profile sedang dipakai: ${error.profile}.\nTutup proses bot/browser lain yang memakai profile itu, atau pakai profile berbeda untuk Gemini dan ChatGPT.`;
  }

  if (error instanceof SessionExpiredError) {
    const loginScript = service === 'gemini' ? 'npm run login:gemini' : 'npm run login:chatgpt';
    return `Sesi ${label} belum login atau kedaluwarsa. Jalankan ${loginScript}, pastikan halaman chat terbuka, lalu start bot lagi.`;
  }

  if (error instanceof SelectorTimeoutError || isTimeoutError(error)) {
    return `${label} belum merespons setelah dicoba ulang. Browser sudah di-reload otomatis, tapi masih timeout.\nDetail: ${error.message}`;
  }

  return `Error: ${error.message || `Gagal meminta jawaban ke ${label}.`}`;
}

function isTimeoutError(error) {
  return error instanceof playwrightErrors.TimeoutError || /timeout/i.test(error?.message || '');
}

function isBrowserProfileInUseError(error) {
  return /ProcessSingleton|SingletonLock|profile directory.*in use/i.test(error?.message || '');
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

class BrowserProfileInUseError extends Error {
  constructor(service, profile, cause) {
    super(`Profile browser ${getWebAiLabel(service)} sedang dipakai: ${profile}.`);
    this.name = 'BrowserProfileInUseError';
    this.profile = profile;
    this.cause = cause;
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
  await resetAllWebAiBrowsers();

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
