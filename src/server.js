import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ConversationStore } from './conversation.js';
import { getConfig, loadEnvFile, validateConfig } from './env.js';
import { generateAiReply } from './openai.js';
import { extractIncomingMessages, verifyMetaSignature, WhatsAppClient } from './whatsapp.js';

export function createServer({ config, logger = console, fetchImpl = fetch } = {}) {
  const conversationStore = new ConversationStore({
    maxTurns: config.maxHistoryTurns,
    ttlMs: config.sessionTtlMs
  });
  const whatsapp = new WhatsAppClient({
    accessToken: config.whatsappAccessToken,
    phoneNumberId: config.whatsappPhoneNumberId,
    graphApiVersion: config.graphApiVersion,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl
  });
  const deduper = new MessageDeduper();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      }

      if (req.method === 'GET' && url.pathname === '/webhook') {
        return verifyWebhook(req, res, url, config);
      }

      if (req.method === 'POST' && url.pathname === '/webhook') {
        return await receiveWebhook(req, res, {
          config,
          logger,
          whatsapp,
          conversationStore,
          deduper
        });
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      logger.error(error);
      return sendJson(res, 500, { error: 'Internal server error' });
    }
  });
}

export async function processIncomingMessage(message, { config, logger = console, whatsapp, conversationStore, deduper }) {
  if (deduper?.isDuplicate(message.id)) return;

  try {
    await whatsapp.markAsRead(message.id);
  } catch (error) {
    logger.warn('Failed to mark WhatsApp message as read:', error.message);
  }

  if (!message.text) {
    await whatsapp.sendText(message.from, 'Maaf, saat ini saya baru bisa memproses pesan teks.');
    return;
  }

  if (isResetCommand(message.text)) {
    conversationStore.clear(message.from);
    await whatsapp.sendText(message.from, 'Konteks percakapan sudah direset.');
    return;
  }

  try {
    const input = conversationStore.buildInput(message.from, message.text, config.systemPrompt);
    const reply = await generateAiReply({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      input,
      maxOutputTokens: config.openaiMaxOutputTokens,
      timeoutMs: config.requestTimeoutMs
    });

    conversationStore.append(message.from, message.text, reply);
    await whatsapp.sendText(message.from, reply);
  } catch (error) {
    logger.error('Failed to generate or send AI reply:', error);
    await whatsapp.sendText(
      message.from,
      'Maaf, AI sedang tidak bisa membalas sekarang. Coba kirim ulang beberapa saat lagi.'
    );
  }
}

async function receiveWebhook(req, res, { config, logger, whatsapp, conversationStore, deduper }) {
  let rawBody;
  try {
    rawBody = await readRawBody(req, config.maxWebhookBytes);
  } catch (error) {
    return sendJson(res, error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: error.message });
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!verifyMetaSignature(rawBody, signature, config.whatsappAppSecret)) {
    return sendJson(res, 401, { error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON payload' });
  }

  const messages = extractIncomingMessages(payload);
  sendJson(res, 200, { ok: true });

  for (const message of messages) {
    processIncomingMessage(message, { config, logger, whatsapp, conversationStore, deduper }).catch((error) => {
      logger.error('Unhandled message processing error:', error);
    });
  }
}

function verifyWebhook(_req, res, url, config) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === config.whatsappVerifyToken) {
    return sendText(res, 200, challenge || '');
  }

  return sendJson(res, 403, { error: 'Webhook verification failed' });
}

async function readRawBody(req, limitBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > limitBytes) {
      const error = new Error('Payload too large');
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  if (res.writableEnded) return;
  res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
  res.end(text);
}

function isResetCommand(text) {
  return /^\/?(reset|clear|hapus konteks)$/i.test(text.trim());
}

class MessageDeduper {
  constructor(limit = 5000) {
    this.limit = limit;
    this.ids = new Set();
    this.queue = [];
  }

  isDuplicate(id) {
    if (!id) return false;
    if (this.ids.has(id)) return true;

    this.ids.add(id);
    this.queue.push(id);

    while (this.queue.length > this.limit) {
      this.ids.delete(this.queue.shift());
    }

    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile();
  const config = getConfig();
  validateConfig(config);

  if (!config.whatsappAppSecret) {
    console.warn('WHATSAPP_APP_SECRET is not set. Webhook signature verification is disabled.');
  }

  const server = createServer({ config });
  server.listen(config.port, () => {
    console.log(`WhatsApp AI bot listening on port ${config.port}`);
    console.log(`Webhook URL path: /webhook`);
  });
}
