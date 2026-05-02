import assert from 'node:assert/strict';
import test from 'node:test';
import { generateReply } from '../src/ai.js';

test('generateReply uses web provider without API fetch calls', async () => {
  const reply = await generateReply({
    config: {
      aiProvider: 'web',
      webAiService: 'chatgpt',
      webAiUrl: '',
      webAiIncludeContext: false
    },
    input: [{ role: 'user', content: 'Buka AI dari web saja' }],
    fetchImpl: async () => {
      throw new Error('fetch should not be called for AI_PROVIDER=web');
    }
  });

  assert.match(reply, /ChatGPT: https:\/\/chatgpt\.com\//);
  assert.match(reply, /Buka AI dari web saja/);
});

test('generateReply sends messages to Ollama when AI_PROVIDER=ollama', async () => {
  const reply = await generateReply({
    config: {
      aiProvider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'llama3.2',
      ollamaKeepAlive: '10m',
      requestTimeoutMs: 1000
    },
    input: [
      { role: 'developer', content: 'Jawab singkat.' },
      { role: 'user', content: 'Halo' }
    ],
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://localhost:11434/api/chat');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'llama3.2');
      assert.equal(body.messages[0].role, 'system');

      return new Response(JSON.stringify({ message: { content: 'Halo juga' } }), { status: 200 });
    }
  });

  assert.equal(reply, 'Halo juga');
});
