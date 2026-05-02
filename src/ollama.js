export async function generateOllamaReply({
  baseUrl = 'http://localhost:11434',
  model,
  messages,
  keepAlive = '10m',
  timeoutMs = 45_000,
  fetchImpl = fetch
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: toOllamaMessages(messages),
        stream: false,
        keep_alive: keepAlive
      }),
      signal: controller.signal
    });

    const payload = await readJsonOrText(response);
    if (!response.ok) {
      throw new Error(`Ollama API ${response.status}: ${formatApiError(payload)}`);
    }

    const text = payload?.message?.content?.trim();
    if (!text) {
      throw new Error('Ollama response did not include message content.');
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function toOllamaMessages(messages) {
  return messages.map((message) => ({
    role: message.role === 'developer' ? 'system' : message.role,
    content: message.content
  }));
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
