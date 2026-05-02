import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from 'baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import { generateReply } from './ai.js';
import { ConversationStore } from './conversation.js';
import { getConfig, loadEnvFile, validateWebBotConfig } from './env.js';
import { splitWhatsAppText } from './whatsapp.js';

const logger = P({ level: process.env.LOG_LEVEL || 'silent' });
const keyStoreLogger = P({ level: process.env.LOG_LEVEL || 'fatal' });
const PAIRING_CODE_DELAY_MS = 3000;

export async function startWhatsAppWebBot({ config, fetchImpl = fetch, log = console } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();
  const conversations = new ConversationStore({
    maxTurns: config.maxHistoryTurns,
    ttlMs: config.sessionTtlMs
  });
  const inFlight = new Set();
  const shouldUsePairingCode = config.usePairingCode && !state.creds.registered;

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, keyStoreLogger)
    },
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 10_000,
    logger,
    markOnlineOnConnect: true,
    printQRInTerminal: false,
    syncFullHistory: false,
    version
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !shouldUsePairingCode) {
      log.info('Scan QR ini lewat WhatsApp > Linked devices:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      log.info('WhatsApp Web bot sudah tersambung.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      log.warn(`Koneksi WhatsApp tertutup. reconnect=${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => {
          startWhatsAppWebBot({ config, fetchImpl, log }).catch((error) => log.error(error));
        }, 3000);
      } else {
        log.warn(`Session logout. Hapus folder ${config.authDir} lalu pairing ulang jika mau login lagi.`);
      }
    }
  });

  if (shouldUsePairingCode) {
    requestLoginPairingCode(sock, config, log).catch((error) => {
      log.error('Gagal membuat pairing code:', error);
    });
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      handleMessage({ sock, message, config, conversations, inFlight, fetchImpl, log }).catch((error) => {
        log.error('Gagal memproses pesan:', error);
      });
    }
  });

  return sock;
}

async function requestLoginPairingCode(sock, config, log) {
  await delay(PAIRING_CODE_DELAY_MS);

  const phoneNumber = await resolvePairingPhoneNumber(config);
  const customPairingCode = normalizeCustomPairingCode(config.pairingCode);
  const code = await sock.requestPairingCode(phoneNumber, customPairingCode || undefined);

  log.info('');
  log.info(`Pairing code: ${formatPairingCode(code)}`);
  log.info(
    'Buka WhatsApp > Linked devices > Link a device > Link with phone number instead, lalu masukkan kode di atas.'
  );
  log.info('');
}

async function resolvePairingPhoneNumber(config) {
  const configured = normalizePhoneNumber(config.pairingPhoneNumber);
  if (configured) return assertValidPairingPhoneNumber(configured);

  if (!input.isTTY) {
    throw new Error('PAIRING_PHONE_NUMBER wajib diisi saat USE_PAIRING_CODE=true di environment non-interaktif.');
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question('Masukkan nomor WhatsApp dengan kode negara, contoh 6281234567890: ');
    const phoneNumber = normalizePhoneNumber(answer);
    return assertValidPairingPhoneNumber(phoneNumber);
  } finally {
    rl.close();
  }
}

export function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

export function isValidPairingPhoneNumber(value) {
  return /^[1-9]\d{6,14}$/.test(String(value || ''));
}

function assertValidPairingPhoneNumber(phoneNumber) {
  if (!isValidPairingPhoneNumber(phoneNumber)) {
    throw new Error(
      'Nomor WhatsApp tidak valid. Pakai format internasional tanpa + atau spasi, contoh 6281234567890.'
    );
  }

  return phoneNumber;
}

function normalizeCustomPairingCode(value) {
  const code = String(value || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();

  if (!code) return '';
  if (code.length !== 8) {
    throw new Error('PAIRING_CODE harus tepat 8 karakter jika diisi.');
  }

  return code;
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

async function handleMessage({ sock, message, config, conversations, inFlight, fetchImpl, log }) {
  const jid = message.key.remoteJid;
  const messageId = message.key.id;

  if (!jid || !messageId || message.key.fromMe || jid === 'status@broadcast') return;
  if (inFlight.has(messageId)) return;
  inFlight.add(messageId);

  try {
    const isGroup = jid.endsWith('@g.us');
    if (isGroup && !config.replyInGroups) return;

    const text = extractText(message);
    const prompt = applyPrefix(text, config.botPrefix);
    if (!prompt) return;

    await sock.readMessages([message.key]);

    if (isResetCommand(prompt)) {
      conversations.clear(jid);
      await sendLongText(sock, jid, 'Konteks percakapan sudah direset.', message);
      return;
    }

    await sock.sendPresenceUpdate('composing', jid);
    const input = conversations.buildInput(jid, prompt, config.systemPrompt);
    const reply = await generateReply({ config, input, fetchImpl });

    conversations.append(jid, prompt, reply);
    await sendLongText(sock, jid, reply, message);
    await sock.sendPresenceUpdate('paused', jid);
  } catch (error) {
    log.error(error);
    await sendLongText(sock, jid, 'Maaf, AI sedang tidak bisa membalas sekarang. Coba lagi nanti.', message);
  } finally {
    inFlight.delete(messageId);
  }
}

function extractText(message) {
  const content = unwrapEphemeral(message.message);
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.buttonsResponseMessage?.selectedDisplayText ||
    content?.listResponseMessage?.title ||
    ''
  ).trim();
}

function unwrapEphemeral(content) {
  return content?.ephemeralMessage?.message || content?.viewOnceMessage?.message || content;
}

function applyPrefix(text, prefix) {
  if (!text) return '';
  if (!prefix) return text;

  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) return '';
  return trimmed.slice(prefix.length).trim();
}

async function sendLongText(sock, jid, text, quotedMessage) {
  for (const chunk of splitWhatsAppText(text)) {
    await sock.sendMessage(jid, { text: chunk }, { quoted: quotedMessage });
  }
}

function isResetCommand(text) {
  return /^\/?(reset|clear|hapus konteks)$/i.test(text.trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile();
  const config = getConfig();
  validateWebBotConfig(config);

  startWhatsAppWebBot({ config }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
