import assert from 'node:assert/strict';
import test from 'node:test';
import { getConfig, validateWebBotConfig } from '../src/env.js';

test('getConfig defaults to web AI mode', () => {
  const config = getConfig({});

  assert.equal(config.aiProvider, 'web');
  assert.equal(config.webAiService, 'chatgpt');
  assert.equal(config.webAiIncludeContext, false);
});

test('validateWebBotConfig accepts web AI mode without API keys', () => {
  assert.doesNotThrow(() => {
    validateWebBotConfig({
      aiProvider: 'web',
      webAiService: 'chatgpt',
      webAiUrl: ''
    });
  });
});

test('validateWebBotConfig requires a URL for custom web AI mode', () => {
  assert.throws(
    () => {
      validateWebBotConfig({
        aiProvider: 'web',
        webAiService: 'custom',
        webAiUrl: ''
      });
    },
    /WEB_AI_URL/
  );
});
