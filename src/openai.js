const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export async function generateAiReply({
  apiKey,
  model,
  input,
  maxOutputTokens = 1200,
  timeoutMs = 45_000,
  fetchImpl = fetch
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input,
        max_output_tokens: maxOutputTokens
      }),
      signal: controller.signal
    });

    const payload = await readJsonOrText(response);
    if (!response.ok) {
      throw new Error(`OpenAI API ${response.status}: ${formatApiError(payload)}`);
    }

    const text = extractOutputText(payload).trim();
    if (!text) {
      throw new Error('OpenAI response did not include text output.');
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string') {
    return payload.output_text;
  }

  const parts = [];
  for (const output of payload?.output || []) {
    for (const content of output?.content || []) {
      if (typeof content?.text === 'string') {
        parts.push(content.text);
      }
    }
  }

  return parts.join('\n');
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
