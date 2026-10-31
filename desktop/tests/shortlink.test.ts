import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSpotifyShortLink, resolveShortLink } from '../src/main/shortlink.js';

test('isSpotifyShortLink: распознаёт короткие хосты', () => {
  assert.equal(isSpotifyShortLink('https://spotify.link/abc123'), true);
  assert.equal(isSpotifyShortLink('https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp'), false);
  assert.equal(isSpotifyShortLink('https://example.com/x'), false);
  assert.equal(isSpotifyShortLink('не ссылка'), false);
});

test('resolveShortLink: следует редиректу и парсит трек', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    url: 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp?si=abcdef',
    json: async () => ({}),
  })) as unknown as typeof fetch;
  try {
    const r = await resolveShortLink('https://spotify.link/abc123');
    assert.equal(r?.trackId, '3n3Ppam7vgaVa1iaRUc9Lp');
  } finally {
    globalThis.fetch = old;
  }
});

test('resolveShortLink: сеть упала → null', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  try {
    const r = await resolveShortLink('https://spotify.link/abc123');
    assert.equal(r, null);
  } finally {
    globalThis.fetch = old;
  }
});
