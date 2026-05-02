import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  extractIncomingMessages,
  splitWhatsAppText,
  verifyMetaSignature
} from '../src/whatsapp.js';

test('extractIncomingMessages extracts text messages from WhatsApp webhook payload', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: 'wamid.1',
                  from: '628123',
                  type: 'text',
                  text: { body: 'Halo bot' }
                }
              ]
            }
          }
        ]
      }
    ]
  };

  assert.deepEqual(extractIncomingMessages(payload), [
    {
      id: 'wamid.1',
      from: '628123',
      type: 'text',
      text: 'Halo bot',
      raw: payload.entry[0].changes[0].value.messages[0]
    }
  ]);
});

test('splitWhatsAppText keeps each chunk under WhatsApp text limit', () => {
  const chunks = splitWhatsAppText('a'.repeat(5000), 4096);

  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 4096));
});

test('verifyMetaSignature validates X-Hub-Signature-256 header', () => {
  const body = Buffer.from('{"hello":"world"}');
  const secret = 'app-secret';
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  assert.equal(verifyMetaSignature(body, signature, secret), true);
  assert.equal(verifyMetaSignature(body, 'sha256=bad', secret), false);
});
