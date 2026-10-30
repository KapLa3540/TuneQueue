import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmtc, emptyState } from '../src/main/player/smtc.js';

test('parseSmtc: валидный ответ', () => {
  const raw = JSON.stringify({
    found: true,
    title: 'Levitating',
    artist: 'Dua Lipa',
    album: 'Future Nostalgia',
    playback: 4,
    posMs: 45000,
    startMs: 0,
    durMs: 0,
    endMs: 203000,
    sessions: ['SpotifyAB.SpotifyMusic_abc!Spotify', 'Chrome'],
  });
  const st = parseSmtc(raw);
  assert.equal(st.found, true);
  assert.equal(st.title, 'Levitating');
  assert.equal(st.artist, 'Dua Lipa');
  assert.equal(st.playback, 'playing');
  assert.equal(st.posMs, 45000);
  assert.equal(st.durMs, 203000);
  assert.equal(st.sessions.length, 2);
});

test('parseSmtc: paused', () => {
  const st = parseSmtc('{"found":true,"title":"A","artist":"B","playback":5,"posMs":1000,"startMs":0,"endMs":10000}');
  assert.equal(st.playback, 'paused');
  assert.equal(st.durMs, 10000);
});

test('parseSmtc: плеер не найден', () => {
  const st = parseSmtc('{"found":false}');
  assert.equal(st.found, false);
  assert.equal(st.playback, 'none');
  assert.deepEqual(st, emptyState());
});

test('parseSmtc: мусор и префикс PowerShell', () => {
  assert.equal(parseSmtc('').found, false);
  assert.equal(parseSmtc('warning: something\n{"found":false}').found, false);
  assert.equal(parseSmtc('not json at all').found, false);
  assert.equal(parseSmtc('{"found":true').found, false); // обрезанный json
});

test('parseSmtc: отрицательная длительность не берём', () => {
  const st = parseSmtc('{"found":true,"title":"A","artist":"B","playback":4,"posMs":0,"startMs":5000,"endMs":0}');
  assert.equal(st.durMs, 0);
});
