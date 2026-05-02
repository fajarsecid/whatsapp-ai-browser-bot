import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { formatGeminiCliPrompt, generateGeminiCliReply } from '../src/gemini-cli.js';

test('formatGeminiCliPrompt keeps system instruction and conversation roles', () => {
  const prompt = formatGeminiCliPrompt([
    { role: 'developer', content: 'Jawab singkat.' },
    { role: 'user', content: 'Halo' },
    { role: 'assistant', content: 'Halo juga' },
    { role: 'user', content: 'Apa kabar?' }
  ]);

  assert.match(prompt, /Jawab singkat/);
  assert.match(prompt, /User: Halo/);
  assert.match(prompt, /Assistant: Halo juga/);
  assert.match(prompt, /User: Apa kabar/);
});

test('generateGeminiCliReply runs Gemini CLI in headless prompt mode', async () => {
  let argsSeen = [];

  const reply = await generateGeminiCliReply({
    command: '/bin/gemini',
    model: 'gemini-test',
    allowApiKey: false,
    input: [{ role: 'user', content: 'Halo' }],
    timeoutMs: 1000,
    spawnImpl: (_command, args) => {
      argsSeen = args;
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdin.on('finish', () => {
        child.stdout.end('Hai dari Gemini\n');
        child.stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    }
  });

  assert.equal(reply, 'Hai dari Gemini');
  assert.ok(argsSeen.includes('--prompt'));
  assert.ok(argsSeen.includes('--skip-trust'));
  assert.ok(argsSeen.includes('--model'));
  assert.ok(argsSeen.includes('gemini-test'));
  assert.match(argsSeen[argsSeen.indexOf('--prompt') + 1], /User: Halo/);
});
