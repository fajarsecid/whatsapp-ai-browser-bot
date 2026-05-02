import assert from 'node:assert/strict';
import test from 'node:test';
import { extractOutputText } from '../src/openai.js';

test('extractOutputText reads output_text helper field', () => {
  assert.equal(extractOutputText({ output_text: 'halo' }), 'halo');
});

test('extractOutputText falls back to response output content array', () => {
  const payload = {
    output: [
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'bagian satu' },
          { type: 'output_text', text: 'bagian dua' }
        ]
      }
    ]
  };

  assert.equal(extractOutputText(payload), 'bagian satu\nbagian dua');
});
