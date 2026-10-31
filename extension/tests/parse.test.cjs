const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/parse.js');

test('реальный кейс из чата: двоеточие + markdown-ссылка', () => {
  const raw =
    ':!sr [https://open.spotify.com/track/2dPYZ5QUwOeWeVc50s9CAU?si=abb55962](https://open.spotify.com/track/2dPYZ5QUwOeWeVc50s9CAU?si=abb55962)';
  const cmd = P.normalizeCommand(raw);
  assert.equal(cmd.name, 'sr');
  assert.equal(cmd.known, true);
  assert.equal(P.extractSpotifyTrack(cmd.rest)?.trackId, '2dPYZ5QUwOeWeVc50s9CAU');
});

test('команды: !sr !play !songrequest и мусор', () => {
  assert.equal(P.normalizeCommand('!play https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp').name, 'play');
  assert.equal(P.normalizeCommand('!songrequest https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp').known, true);
  assert.equal(P.normalizeCommand('привет'), null);
  assert.equal(P.normalizeCommand('!timeout 10').known, false);
});

test('extract: ссылка в любом месте, uri, отсев мусора', () => {
  assert.equal(
    P.extractSpotifyTrack('вот дай этот трек spotify:track:3n3Ppam7vgaVa1iaRUc9Lp ок')?.trackId,
    '3n3Ppam7vgaVa1iaRUc9Lp',
  );
  assert.equal(
    P.extractSpotifyTrack('[https://open.spotify.com/intl-ru/track/3n3Ppam7vgaVa1iaRUc9Lp?si=1](https://x)')?.trackId,
    '3n3Ppam7vgaVa1iaRUc9Lp',
  );
  assert.equal(P.extractSpotifyTrack('просто текст'), null);
  assert.equal(P.extractSpotifyTrack('https://open.spotify.com/album/3n3Ppam7vgaVa1iaRUc9Lp'), null);
});

test('matchAddToQueue: языки меню', () => {
  assert.equal(P.matchAddToQueue('Add to queue'), true);
  assert.equal(P.matchAddToQueue('Добавить в очередь'), true);
  assert.equal(P.matchAddToQueue('Añadir a la cola'), true);
  assert.equal(P.matchAddToQueue('Очередь'), false);
  assert.equal(P.matchAddToQueue('Play'), false);
  assert.equal(P.matchAddToQueue(''), false);
});

test('кулдаун', () => {
  const map = new Map();
  assert.equal(P.cooldownAllows(map, 'u', 1000, 15000), true);
  assert.equal(P.cooldownAllows(map, 'u', 5000, 15000), false);
  assert.equal(P.cooldownAllows(map, 'u', 20000, 15000), true);
  assert.equal(P.cooldownAllows(map, 'v', 5000, 15000), true);
});

test('короткие ссылки spotify.link', () => {
  assert.equal(P.isSpotifyShortLink('https://spotify.link/abc'), true);
  assert.equal(P.isSpotifyShortLink('https://open.spotify.com/track/x'), false);
});
