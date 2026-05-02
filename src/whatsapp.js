import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_WHATSAPP_TEXT_LENGTH = 4096;

export class WhatsAppClient {
  constructor({ accessToken, phoneNumberId, graphApiVersion = 'v25.0', timeoutMs = 45_000, fetchImpl = fetch }) {
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.graphApiVersion = graphApiVersion;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async sendText(to, body) {
    const chunks = splitWhatsAppText(body);
    const results = [];

    for (const chunk of chunks) {
      results.push(
        await this.postMessage({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: {
            preview_url: false,
            body: chunk
          }
        })
      );
    }

    return results;
  }

  async markAsRead(messageId) {
    if (!messageId) return null;
    return this.postMessage({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    });
  }

  async postMessage(payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.messagesUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const responseBody = await readJsonOrText(response);
      if (!response.ok) {
        throw new Error(`WhatsApp API ${response.status}: ${formatApiError(responseBody)}`);
      }

      return responseBody;
    } finally {
      clearTimeout(timeout);
    }
  }

  messagesUrl() {
    return `https://graph.facebook.com/${this.graphApiVersion}/${this.phoneNumberId}/messages`;
  }
}

export function extractIncomingMessages(payload) {
  const messages = [];

  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      for (const message of value?.messages || []) {
        messages.push({
          id: message.id,
          from: message.from,
          type: message.type,
          text: extractMessageText(message),
          raw: message
        });
      }
    }
  }

  return messages.filter((message) => message.from);
}

export function extractMessageText(message) {
  if (message?.type === 'text') return cleanText(message.text?.body);
  if (message?.type === 'button') return cleanText(message.button?.text);

  if (message?.type === 'interactive') {
    return cleanText(
      message.interactive?.button_reply?.title ||
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.title ||
        message.interactive?.list_reply?.id
    );
  }

  return '';
}

export function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true;
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signatureHeader);

  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function splitWhatsAppText(input, maxLength = MAX_WHATSAPP_TEXT_LENGTH) {
  let text = String(input || '').trim();
  if (!text) return ['...'];

  const chunks = [];
  while (text.length > maxLength) {
    let splitAt = text.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength * 0.6) splitAt = text.lastIndexOf(' ', maxLength);
    if (splitAt < maxLength * 0.6) splitAt = maxLength;

    chunks.push(text.slice(0, splitAt).trim());
    text = text.slice(splitAt).trim();
  }

  if (text) chunks.push(text);
  return chunks;
}

function cleanText(text) {
  return typeof text === 'string' ? text.trim() : '';
}

async function readJsonOrText(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatApiError(payload) {
  if (typeof payload === 'string') return payload.slice(0, 1000);
  return JSON.stringify(payload).slice(0, 1000);
}
