import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpotifyTrack, QueueService, COOLDOWN_MS, MAX_ACTIVE } from '../src/main/queue.js';

test('parseSpotifyTrack: обычные ссылки', () => {
  const a = parseSpotifyTrack('https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp');
  assert.equal(a?.trackId, '3n3Ppam7vgaVa1iaRUc9Lp');
  assert.equal(a?.url, 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp');

  const b = parseSpotifyTrack('https://open.spotify.com/intl-ru/track/3n3Ppam7vgaVa1iaRUc9Lp?si=abc');
  assert.equal(b?.trackId, '3n3Ppam7vgaVa1iaRUc9Lp');

  const c = parseSpotifyTrack('open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp');
  assert.equal(c?.trackId, '3n3Ppam7vgaVa1iaRUc9Lp');
});

test('parseSpotifyTrack: uri формат', () => {
  const u = parseSpotifyTrack('spotify:track:3n3Ppam7vgaVa1iaRUc9Lp');
  assert.equal(u?.trackId, '3n3Ppam7vgaVa1iaRUc9Lp');
});

test('parseSpotifyTrack: отвергает мусор и не-треки', () => {
  assert.equal(parseSpotifyTrack('дайфт панк один раз больше'), null);
  assert.equal(parseSpotifyTrack('https://open.spotify.com/album/3n3Ppam7vgaVa1iaRUc9Lp'), null);
  assert.equal(parseSpotifyTrack('https://open.spotify.com/track/short'), null);
  assert.equal(parseSpotifyTrack('https://example.com/track/3n3Ppam7vgaVa1iaRUc9Lp'), null);
  assert.equal(parseSpotifyTrack(''), null);
});

test('очередь: порядок и статусы', () => {
  const q = new QueueService();
  const r1 = q.add(parseSpotifyTrack('https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp')!, 'alice', 'ch');
  const r2 = q.add(parseSpotifyTrack('spotify:track:2De5lqHgGAgCJdLcM6cS4A')!, 'bob', 'ch');
  assert.ok(r1.ok && r2.ok);
  assert.equal(q.firstQueued()?.id, r1.item!.id);

  q.mark(r1.item!.id, 'playing');
  assert.equal(q.firstQueued()?.id, r2.item!.id);

  q.mark(r1.item!.id, 'done');
  assert.equal(q.queuedCount(), 1);
  assert.equal(q.clearFinished(), 1); // done убран, queued остался
  assert.equal(q.queuedCount(), 1);
});

test('очередь: кулдаун на юзера', () => {
  let t = 1_000_000;
  const q = new QueueService(() => t);
  const url = 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp';
  assert.ok(q.add(parseSpotifyTrack(url)!, 'alice', 'ch').ok);
  const second = q.add(parseSpotifyTrack(url)!, 'alice', 'ch');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'cooldown');

  // другой юзер — можно
  assert.ok(q.add(parseSpotifyTrack(url)!, 'bob', 'ch').ok);
  // тот же юзер после кулдауна — можно
  t += COOLDOWN_MS + 1;
  assert.ok(q.add(parseSpotifyTrack(url)!, 'alice', 'ch').ok);
});

test('очередь: лимит активных', () => {
  let t = 0;
  const q = new QueueService(() => t);
  for (let i = 0; i < MAX_ACTIVE; i++) {
    t += COOLDOWN_MS + 1;
    const r = q.add(parseSpotifyTrack('spotify:track:3n3Ppam7vgaVa1iaRUc9Lp')!, `u${i}`, 'ch');
    assert.ok(r.ok, `add #${i} should ok`);
  }
  t += COOLDOWN_MS + 1;
  const over = q.add(parseSpotifyTrack('spotify:track:3n3Ppam7vgaVa1iaRUc9Lp')!, 'late', 'ch');
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'full');
});

test('очередь: нельзя убрать играющий, можно queued', () => {
  const q = new QueueService();
  const a = q.add(parseSpotifyTrack('spotify:track:3n3Ppam7vgaVa1iaRUc9Lp')!, 'a', 'ch').item!;
  const b = q.add(parseSpotifyTrack('spotify:track:2De5lqHgGAgCJdLcM6cS4A')!, 'b', 'ch').item!;
  q.mark(a.id, 'playing');
  assert.equal(q.remove(a.id), false);
  assert.equal(q.remove(b.id), true);
  assert.equal(q.remove(999), false);
});
