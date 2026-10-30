import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServingController } from '../src/main/serving.js';
import { QueueService, parseSpotifyTrack } from '../src/main/queue.js';
import type { PlayerPort } from '../src/main/player/windows.js';
import type { SpotifyMediaState } from '../src/main/player/smtc.js';

const state = (over: Partial<SpotifyMediaState> = {}): SpotifyMediaState => ({
  found: true,
  title: 'Other',
  artist: 'Artist',
  album: '',
  playback: 'playing',
  posMs: 1000,
  durMs: 60000,
  sessions: [],
  ...over,
});

class FakePlayer implements PlayerPort {
  spInstalled = true;
  spawned: string[] = [];
  failSpawn = false;
  state: SpotifyMediaState = state();

  installed(): boolean {
    return this.spInstalled;
  }
  async spawnTrack(id: string): Promise<void> {
    if (this.failSpawn) throw new Error('spawn failed');
    this.spawned.push(id);
  }
  async read(): Promise<SpotifyMediaState> {
    return this.state;
  }
}

function setup(autoplayOn = true) {
  let clock = 1_000_000;
  let autoplay = autoplayOn;
  const notices: string[] = [];
  const player = new FakePlayer();
  const queue = new QueueService(() => clock);
  const ctl = new ServingController({
    player,
    queue,
    now: () => clock,
    autoplay: () => autoplay,
    setAutoplay: (on) => (autoplay = on),
    onNotice: (m) => notices.push(m),
    failLimit: 3,
  });
  const advance = (ms: number) => (clock += ms);
  const add = (id22: string, by: string) => {
    const p = parseSpotifyTrack(`spotify:track:${id22}`);
    assert.ok(p);
    const r = queue.add(p, by, 'ch');
    assert.ok(r.ok);
    return r.item!;
  };
  return { ctl, queue, player, notices, advance, add, isAutoplay: () => autoplay };
}

const ID1 = '3n3Ppam7vgaVa1iaRUc9Lp';
const ID2 = '2De5lqHgGAgCJdLcM6cS4A';
const ID3 = '0eGsygTp906u18L0Oimnem';

test('раздача: idle → inject → serve → естественный конец → следующий трек', async () => {
  const s = setup();
  const t1 = s.add(ID1, 'alice');
  const t2 = s.add(ID2, 'bob');

  // 1-й тик: спавним первый трек
  await s.ctl.tick();
  assert.deepEqual(s.player.spawned, [ID1]);
  assert.equal(s.queue.get(t1.id)?.status, 'playing');
  assert.equal(s.ctl.mode, 'injecting');

  // плеер переключился на наш трек
  s.player.state = state({ title: 'Song One', artist: 'One', durMs: 100000, posMs: 3000 });
  await s.ctl.tick();
  assert.equal(s.ctl.mode, 'serving');

  // естественный конец (позиция у финала)
  s.player.state = state({ title: 'Song One', artist: 'One', durMs: 100000, posMs: 98000 });
  await s.ctl.tick();
  assert.equal(s.queue.get(t1.id)?.status, 'done');
  assert.equal(s.ctl.mode, 'idle');

  // после паузы между треками — ставим второй
  s.advance(2000);
  s.player.state = state({ title: 'Radio Song', artist: 'Auto' });
  await s.ctl.tick();
  assert.deepEqual(s.player.spawned, [ID1, ID2]);
  assert.equal(s.queue.get(t2.id)?.status, 'playing');
  assert.equal(s.ctl.mode, 'injecting');
});

test('раздача: ручной скип стримера → skipped → следующий', async () => {
  const s = setup();
  const t1 = s.add(ID1, 'alice');
  s.add(ID2, 'bob');

  await s.ctl.tick(); // inject
  s.player.state = state({ title: 'Song One', artist: 'One', durMs: 100000, posMs: 1000 });
  await s.ctl.tick(); // serving
  assert.equal(s.ctl.mode, 'serving');

  // стример скипнул на середине — трек сменился рано
  s.advance(5000);
  s.player.state = state({ title: 'Something Else', artist: 'X', durMs: 9000 });
  await s.ctl.tick();
  assert.equal(s.queue.get(t1.id)?.status, 'skipped');
  assert.equal(s.ctl.mode, 'idle');
});

test('раздача: автоплей выключен → ничего не ставим', async () => {
  const s = setup(false);
  s.add(ID1, 'alice');
  await s.ctl.tick();
  assert.equal(s.player.spawned.length, 0);
  assert.equal(s.ctl.mode, 'off');
});

test('раздача: спавн падает → failed, после 3 провалов автоплей выключается', async () => {
  const s = setup();
  s.player.spInstalled = false; // Spotify не установлен
  s.add(ID1, 'a');
  s.add(ID2, 'b');
  s.add(ID3, 'c');

  await s.ctl.tick();
  assert.equal(s.queue.all().find((i) => i.trackId === ID1)?.status, 'failed');
  s.advance(4000);
  await s.ctl.tick();
  s.advance(4000);
  await s.ctl.tick();

  assert.equal(s.isAutoplay(), false, 'автоплей должен выключиться после лимита провалов');
  assert.ok(s.notices.some((n) => n.includes('остановлена')));
});

test('раздача: pлеер не запускался → inject-дедлайн → failed', async () => {
  const s = setup();
  const t1 = s.add(ID1, 'a');
  s.player.state = state({ found: false }); // плеер не найден, но installed() true
  await s.ctl.tick();
  assert.equal(s.ctl.mode, 'injecting');

  // прошло больше 70 секунд, состояние так и не изменилось
  s.advance(71_000);
  await s.ctl.tick();
  assert.equal(s.queue.get(t1.id)?.status, 'failed');
  assert.equal(s.ctl.mode, 'idle');
});
