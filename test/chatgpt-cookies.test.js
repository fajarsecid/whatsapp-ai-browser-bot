import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeChatGptCookies, parseChatGptCookieFile } from '../src/chatgpt-cookies.js';

test('parseChatGptCookieFile accepts a raw JSON cookie array', () => {
  assert.deepEqual(parseChatGptCookieFile('[{"name":"a","value":"1","domain":"chatgpt.com","path":"/"}]'), [
    {
      name: 'a',
      value: '1',
      domain: 'chatgpt.com',
      path: '/'
    }
  ]);
});

test('parseChatGptCookieFile accepts a simple JS export wrapper', () => {
  assert.deepEqual(
    parseChatGptCookieFile('export default [{"name":"a","value":"1","domain":"chatgpt.com","path":"/"}];'),
    [
      {
        name: 'a',
        value: '1',
        domain: 'chatgpt.com',
        path: '/'
      }
    ]
  );
});

test('normalizeChatGptCookies converts browser export fields for Playwright', () => {
  const cookies = normalizeChatGptCookies(
    [
      {
        name: 'session',
        value: 'abc',
        domain: '.chatgpt.com',
        path: '/',
        expirationDate: 200,
        httpOnly: true,
        secure: true,
        sameSite: 'no_restriction',
        partitionKey: {
          topLevelSite: 'https://chatgpt.com'
        }
      }
    ],
    { now: 100 }
  );

  assert.deepEqual(cookies, [
    {
      name: 'session',
      value: 'abc',
      domain: '.chatgpt.com',
      path: '/',
      expires: 200,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      partitionKey: 'https://chatgpt.com'
    }
  ]);
});

test('normalizeChatGptCookies skips expired cookies', () => {
  assert.deepEqual(
    normalizeChatGptCookies(
      [
        {
          name: 'expired',
          value: 'old',
          domain: '.chatgpt.com',
          path: '/',
          expirationDate: 50
        }
      ],
      { now: 100 }
    ),
    []
  );
});
