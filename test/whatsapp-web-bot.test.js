import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidPairingPhoneNumber, normalizePhoneNumber } from '../src/whatsapp-web-bot.js';

test('normalizePhoneNumber keeps only digits for Baileys pairing code', () => {
  assert.equal(normalizePhoneNumber('+62 812-3456-7890'), '6281234567890');
});

test('isValidPairingPhoneNumber accepts international phone numbers only', () => {
  assert.equal(isValidPairingPhoneNumber('6281234567890'), true);
  assert.equal(isValidPairingPhoneNumber('081234567890'), false);
  assert.equal(isValidPairingPhoneNumber('123456'), false);
  assert.equal(isValidPairingPhoneNumber('1234567890123456'), false);
});
