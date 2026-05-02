import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_CHATGPT_COOKIE_FILE = './cookie.js';

const SAME_SITE_VALUES = new Map([
  ['strict', 'Strict'],
  ['lax', 'Lax'],
  ['no_restriction', 'None'],
  ['none', 'None']
]);

export async function addChatGptCookiesFromFile(context, cookieFilePath = DEFAULT_CHATGPT_COOKIE_FILE) {
  const source = resolve(cookieFilePath);
  if (!existsSync(source)) {
    return {
      source,
      added: 0,
      skipped: true
    };
  }

  const content = await readFile(source, 'utf8');
  const sourceCookies = parseChatGptCookieFile(content);
  const cookies = normalizeChatGptCookies(sourceCookies);

  if (cookies.length === 0) {
    throw new Error(`${cookieFilePath} tidak berisi cookie aktif yang bisa dipakai Playwright.`);
  }

  await context.addCookies(cookies);

  return {
    source,
    added: cookies.length,
    skipped: false
  };
}

export function parseChatGptCookieFile(content) {
  const text = stripKnownJsExport(content);
  let cookies;

  try {
    cookies = JSON.parse(text);
  } catch (error) {
    throw new Error(
      'cookie.js harus berisi JSON array cookie, atau JSON array dengan wrapper `export default`/`module.exports =`.'
    );
  }

  if (!Array.isArray(cookies)) {
    throw new Error('cookie.js harus berisi array cookie.');
  }

  return cookies;
}

export function normalizeChatGptCookies(sourceCookies, { now = Date.now() / 1000 } = {}) {
  return sourceCookies
    .map((cookie, index) => normalizeChatGptCookie(cookie, index, now))
    .filter(Boolean);
}

function stripKnownJsExport(content) {
  let text = String(content || '')
    .replace(/^\uFEFF/, '')
    .trim();

  text = text.replace(/^export\s+default\s+/, '');
  text = text.replace(/^module\.exports\s*=\s*/, '');
  text = text.replace(/^exports\.default\s*=\s*/, '');

  if (text.endsWith(';')) {
    text = text.slice(0, -1).trim();
  }

  return text;
}

function normalizeChatGptCookie(cookie, index, now) {
  if (!cookie || typeof cookie !== 'object') {
    throw new Error(`Cookie index ${index} bukan object.`);
  }

  const name = normalizeRequiredString(cookie.name, `Cookie index ${index} tidak punya name.`);
  const value = normalizeCookieValue(cookie.value, `Cookie ${name} tidak punya value.`);
  const domain = normalizeRequiredString(cookie.domain, `Cookie ${name} tidak punya domain.`);
  const path = normalizeCookiePath(cookie.path);

  const normalized = {
    name,
    value,
    domain,
    path
  };

  const expires = normalizeExpires(cookie);
  if (expires !== undefined) {
    if (expires <= now) return null;
    normalized.expires = expires;
  }

  if (typeof cookie.httpOnly === 'boolean') normalized.httpOnly = cookie.httpOnly;
  if (typeof cookie.secure === 'boolean') normalized.secure = cookie.secure;

  const sameSite = normalizeSameSite(cookie.sameSite);
  if (sameSite) normalized.sameSite = sameSite;

  const partitionKey = normalizePartitionKey(cookie.partitionKey);
  if (partitionKey) normalized.partitionKey = partitionKey;

  return normalized;
}

function normalizeRequiredString(value, message) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeCookieValue(value, message) {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return String(value);
}

function normalizeCookiePath(value) {
  const path = String(value || '/').trim();
  return path || '/';
}

function normalizeExpires(cookie) {
  const value = cookie.expirationDate ?? cookie.expires;
  if (value === undefined || value === null) return undefined;

  const expires = Number(value);
  if (!Number.isFinite(expires)) return undefined;

  return Math.floor(expires);
}

function normalizeSameSite(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  return SAME_SITE_VALUES.get(normalized);
}

function normalizePartitionKey(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value.topLevelSite === 'string') return value.topLevelSite.trim();
  return '';
}
