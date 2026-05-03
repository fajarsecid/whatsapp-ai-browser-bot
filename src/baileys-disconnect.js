import { DisconnectReason } from '@whiskeysockets/baileys';

const NON_RECONNECTABLE_CODES = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.connectionReplaced,
  DisconnectReason.multideviceMismatch,
  DisconnectReason.forbidden
]);

export function getBaileysDisconnectInfo(lastDisconnect) {
  const error = lastDisconnect?.error;
  const statusCode = normalizeStatusCode(
    error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode
  );

  return {
    statusCode,
    reason: getDisconnectReasonName(statusCode),
    message: getDisconnectMessage(error),
    shouldReconnect: shouldReconnectBaileys(statusCode)
  };
}

export function shouldReconnectBaileys(statusCode) {
  if (statusCode === null || statusCode === undefined) return true;
  return !NON_RECONNECTABLE_CODES.has(statusCode);
}

export function formatBaileysDisconnect(info) {
  const parts = [
    'Koneksi WhatsApp tertutup.',
    `code=${info.statusCode ?? 'unknown'}`,
    `reason=${info.reason || 'unknown'}`
  ];

  if (info.message) {
    parts.push(`message="${info.message}"`);
  }

  parts.push(`reconnect=${info.shouldReconnect}`);
  return parts.join(' ');
}

export function getBaileysDisconnectAdvice(info, authDir) {
  switch (info.statusCode) {
    case DisconnectReason.loggedOut:
      return `Session logout. Hapus folder ${authDir} lalu pairing ulang jika mau login lagi.`;
    case DisconnectReason.connectionReplaced:
      return `Koneksi digantikan oleh proses lain. Pastikan hanya satu bot memakai AUTH_DIR ${authDir}.`;
    case DisconnectReason.badSession:
      return `Session WhatsApp tidak valid/rusak. Backup lalu hapus folder ${authDir} dan pairing ulang.`;
    case DisconnectReason.multideviceMismatch:
      return `Session WhatsApp tidak cocok dengan mode multi-device. Hapus folder ${authDir} lalu pairing ulang.`;
    case DisconnectReason.forbidden:
      return `WhatsApp menolak session ini. Hapus folder ${authDir} lalu pairing ulang.`;
    default:
      return `Reconnect dimatikan untuk alasan ini. Periksa folder session ${authDir} dan pairing ulang jika perlu.`;
  }
}

function normalizeStatusCode(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getDisconnectReasonName(statusCode) {
  if (statusCode === null || statusCode === undefined) return 'unknown';
  return DisconnectReason[statusCode] || 'unknown';
}

function getDisconnectMessage(error) {
  const message = error?.message || error?.output?.payload?.message || '';
  return String(message).replace(/\s+/g, ' ').trim().slice(0, 240);
}
