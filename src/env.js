import { existsSync, readFileSync } from 'node:fs';
import { isSupportedWebAiService } from './web-ai.js';

export function loadEnvFile(filePath = '.env', env = process.env) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(env, key)) continue;

    env[key] = normalizeEnvValue(rawValue);
  }
}

export function getConfig(env = process.env) {
  return {
    port: parseInteger(env.PORT, 3000),
    aiProvider: env.AI_PROVIDER || 'web',
    webAiService: env.WEB_AI_SERVICE || 'chatgpt',
    webAiUrl: env.WEB_AI_URL || '',
    webAiIncludeContext: parseBoolean(env.WEB_AI_INCLUDE_CONTEXT, false),
    geminiCliCommand: env.GEMINI_CLI_COMMAND || 'gemini',
    geminiCliModel: env.GEMINI_CLI_MODEL || '',
    geminiCliCwd: env.GEMINI_CLI_CWD || process.cwd(),
    geminiCliAllowApiKey: parseBoolean(env.GEMINI_CLI_ALLOW_API_KEY, false),
    ollamaBaseUrl: env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaModel: env.OLLAMA_MODEL || 'llama3.2',
    ollamaKeepAlive: env.OLLAMA_KEEP_ALIVE || '10m',
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL || 'gpt-4.1-mini',
    openaiMaxOutputTokens: parseInteger(env.OPENAI_MAX_OUTPUT_TOKENS, 1200),
    whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN,
    whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN,
    whatsappAppSecret: env.WHATSAPP_APP_SECRET,
    graphApiVersion: env.GRAPH_API_VERSION || 'v25.0',
    sessionTtlMs: parseInteger(env.SESSION_TTL_MINUTES, 180) * 60 * 1000,
    maxHistoryTurns: parseInteger(env.MAX_HISTORY_TURNS, 8),
    requestTimeoutMs: parseInteger(env.REQUEST_TIMEOUT_MS, 45_000),
    maxWebhookBytes: parseInteger(env.MAX_WEBHOOK_BYTES, 1_048_576),
    botPrefix: env.BOT_PREFIX || '',
    replyInGroups: parseBoolean(env.REPLY_IN_GROUPS, false),
    authDir: env.AUTH_DIR || 'auth_info_baileys',
    usePairingCode: parseBoolean(env.USE_PAIRING_CODE, true),
    pairingPhoneNumber: env.PAIRING_PHONE_NUMBER || '',
    pairingCode: env.PAIRING_CODE || '',
    systemPrompt:
      env.SYSTEM_PROMPT ||
      'Kamu adalah asisten AI yang membantu lewat WhatsApp. Jawab dalam bahasa pengguna, ringkas, jelas, dan praktis.'
  };
}

export function validateConfig(config) {
  const missing = [
    ['OPENAI_API_KEY', config.openaiApiKey],
    ['WHATSAPP_ACCESS_TOKEN', config.whatsappAccessToken],
    ['WHATSAPP_PHONE_NUMBER_ID', config.whatsappPhoneNumberId],
    ['WHATSAPP_VERIFY_TOKEN', config.whatsappVerifyToken]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export function validateWebBotConfig(config) {
  const provider = config.aiProvider.toLowerCase();
  const webAiService = String(config.webAiService || 'chatgpt').toLowerCase();
  if (!['web', 'gemini-cli', 'ollama', 'openai'].includes(provider)) {
    throw new Error('AI_PROVIDER must be "web", "gemini-cli", "ollama", or "openai".');
  }

  if (provider === 'web' && !isSupportedWebAiService(webAiService)) {
    throw new Error('WEB_AI_SERVICE must be "chatgpt", "gemini", "copilot", "perplexity", "all", or "custom".');
  }

  if (provider === 'web' && webAiService === 'custom' && !config.webAiUrl) {
    throw new Error('WEB_AI_URL is required when WEB_AI_SERVICE=custom.');
  }

  if (provider === 'openai' && !config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai.');
  }
}

function normalizeEnvValue(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    const unquoted = trimmed.slice(1, -1);
    return quote === '"' ? unquoted.replaceAll('\\n', '\n') : unquoted;
  }
  return trimmed;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}
