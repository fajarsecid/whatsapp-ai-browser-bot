export const WEB_AI_SERVICES = Object.freeze({
  chatgpt: {
    label: 'ChatGPT',
    url: 'https://chatgpt.com/'
  },
  gemini: {
    label: 'Gemini',
    url: 'https://gemini.google.com/app'
  },
  copilot: {
    label: 'Microsoft Copilot',
    url: 'https://copilot.microsoft.com/'
  },
  perplexity: {
    label: 'Perplexity',
    url: 'https://www.perplexity.ai/'
  }
});

export function generateWebAiReply({ input, service = 'chatgpt', customUrl = '', includeContext = false } = {}) {
  const targets = resolveWebAiTargets(service, customUrl);
  const prompt = includeContext ? formatWebAiPrompt(input) : getLastUserMessage(input);

  if (!prompt) {
    throw new Error('Tidak ada pesan user untuk dikirim ke AI web.');
  }

  return [
    'Mode web AI aktif. Buka link ini di browser, lalu tempel prompt di bawah.',
    ...targets.map((target) => `${target.label}: ${target.url}`),
    '',
    'Prompt:',
    prompt
  ].join('\n');
}

export function resolveWebAiTargets(service = 'chatgpt', customUrl = '') {
  const normalized = normalizeWebAiService(service);

  if (normalized === 'all') {
    return Object.values(WEB_AI_SERVICES);
  }

  if (normalized === 'custom') {
    return [
      {
        label: 'AI web',
        url: normalizeHttpUrl(customUrl, 'WEB_AI_URL wajib diisi kalau WEB_AI_SERVICE=custom.')
      }
    ];
  }

  const target = WEB_AI_SERVICES[normalized];
  if (!target) {
    throw new Error(`WEB_AI_SERVICE tidak dikenal: ${service}`);
  }

  return [target];
}

export function isSupportedWebAiService(service) {
  const normalized = normalizeWebAiService(service);
  return normalized === 'all' || normalized === 'custom' || Object.hasOwn(WEB_AI_SERVICES, normalized);
}

function normalizeWebAiService(service) {
  return String(service || 'chatgpt')
    .trim()
    .toLowerCase();
}

function getLastUserMessage(input = []) {
  return [...input]
    .reverse()
    .find((message) => message?.role === 'user')
    ?.content?.trim() || '';
}

function formatWebAiPrompt(input = []) {
  return input
    .map((message) => {
      if (!message?.content?.trim()) return '';

      if (message.role === 'assistant') return `Assistant: ${message.content}`;
      if (message.role === 'user') return `User: ${message.content}`;
      return `Instruksi: ${message.content}`;
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function normalizeHttpUrl(value, missingMessage) {
  const rawUrl = String(value || '').trim();
  if (!rawUrl) {
    throw new Error(missingMessage);
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('WEB_AI_URL harus URL http/https yang valid.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WEB_AI_URL harus memakai http atau https.');
  }

  return url.toString();
}
