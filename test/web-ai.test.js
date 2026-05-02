import assert from 'node:assert/strict';
import test from 'node:test';
import { generateWebAiReply, resolveWebAiTargets } from '../src/web-ai.js';

test('generateWebAiReply builds a browser link and the last user prompt', () => {
  const reply = generateWebAiReply({
    service: 'chatgpt',
    input: [
      { role: 'developer', content: 'Jawab singkat.' },
      { role: 'user', content: 'Halo' },
      { role: 'assistant', content: 'Halo juga' },
      { role: 'user', content: 'Jelaskan DNS' }
    ]
  });

  assert.match(reply, /ChatGPT: https:\/\/chatgpt\.com\//);
  assert.match(reply, /Jelaskan DNS/);
  assert.doesNotMatch(reply, /Halo juga/);
});

test('generateWebAiReply can include conversation context when requested', () => {
  const reply = generateWebAiReply({
    service: 'gemini',
    includeContext: true,
    input: [
      { role: 'developer', content: 'Jawab bahasa Indonesia.' },
      { role: 'user', content: 'Halo' },
      { role: 'assistant', content: 'Halo juga' },
      { role: 'user', content: 'Lanjutkan' }
    ]
  });

  assert.match(reply, /Gemini: https:\/\/gemini\.google\.com\/app/);
  assert.match(reply, /Instruksi: Jawab bahasa Indonesia/);
  assert.match(reply, /Assistant: Halo juga/);
  assert.match(reply, /User: Lanjutkan/);
});

test('resolveWebAiTargets supports custom http URLs', () => {
  assert.deepEqual(resolveWebAiTargets('custom', 'https://example.com/chat'), [
    {
      label: 'AI web',
      url: 'https://example.com/chat'
    }
  ]);
});
