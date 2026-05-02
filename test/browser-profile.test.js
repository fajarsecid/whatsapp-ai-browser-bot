import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBrowserProfile } from '../src/browser-profile.js';

test('resolveBrowserProfile returns separate defaults per service', () => {
  assert.equal(resolveBrowserProfile('gemini', { env: {} }), './browser-profile-gemini');
  assert.equal(resolveBrowserProfile('chatgpt', { env: {} }), './browser-profile');
});

test('resolveBrowserProfile prefers explicit service profile variables', () => {
  const env = {
    BROWSER_PROFILE: './legacy-profile',
    GEMINI_BROWSER_PROFILE: './gemini-custom',
    CHATGPT_BROWSER_PROFILE: './chatgpt-custom'
  };

  assert.equal(resolveBrowserProfile('gemini', { env }), './gemini-custom');
  assert.equal(resolveBrowserProfile('chatgpt', { env }), './chatgpt-custom');
});

test('resolveBrowserProfile limits legacy BROWSER_PROFILE to the startup service', () => {
  const env = { BROWSER_PROFILE: './browser-profile-gemini' };

  assert.equal(resolveBrowserProfile('gemini', { env, legacyService: 'gemini' }), './browser-profile-gemini');
  assert.equal(resolveBrowserProfile('chatgpt', { env, legacyService: 'gemini' }), './browser-profile');
});
