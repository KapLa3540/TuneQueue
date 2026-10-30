import type { PlayerPort } from './player/windows.js';
import type { QueueService } from './queue.js';
import type { SpotifyMediaState } from './player/smtc.js';

export type ServeMode = 'off' | 'idle' | 'injecting' | 'serving';

export interface ServingDeps {
  player: PlayerPort;
  queue: QueueService;
  now(): number;
  autoplay(): boolean;
  setAutoplay?(on: boolean): void;
  onNotice(msg: string): void;
  /** провал подряд -> выключаем автоплей */
  failLimit?: number;
}

const tuple = (s: SpotifyMediaState): string => `${s.title} ${s.artist}`;

/**
 * Раздача очереди в локальный плеер:
 *   idle → (есть queued и автоплей) → inject (spawnTrack) → serving (ждём конца/скипа) → idle → …
 * Естественный конец и ручной скип стримера определяются по смене трека в SMTC.
 */
export class ServingController {
  mode: ServeMode = 'idle';
  servingId: number | null = null;
  lastState: SpotifyMediaState | null = null;

  private preTuple = '';
  private injectDeadline = 0;
  private servingTitle = '';
  private servingArtist = '';
  private servingDur = 0;
  private servingStart = 0;
  private nextAllowedAt = 0;
  private fails = 0;

  constructor(private readonly deps: ServingDeps) {}

  async tick(): Promise<void> {
    const { player, queue, now, autoplay } = this.deps;

    if (!autoplay()) {
      if (this.mode !== 'off') {
        this.mode = 'off';
        this.servingId = null;
      }
      this.lastState = await player.read().catch(() => null);
      return;
    }
    if (this.mode === 'off') {
      this.mode = 'idle';
      this.fails = 0;
    }

    const st = await player.read().catch(() => null);
    if (st) this.lastState = st;
    const t = now();

    if (this.mode === 'idle') {
      if (t < this.nextAllowedAt) return;
      const next = queue.firstQueued();
      if (!next) return;

      if (!player.installed()) {
        this.failItem(next.id, 'Spotify не установлен');
        return;
      }

      this.preTuple = st && st.found ? tuple(st) : '';
      try {
        await player.spawnTrack(next.trackId);
      } catch (err) {
        this.failItem(next.id, err instanceof Error ? err.message : String(err));
        return;
      }
      queue.mark(next.id, 'playing');
      this.mode = 'injecting';
      this.servingId = next.id;
      this.injectDeadline = t + 70_000;
      this.deps.onNotice(`▶ Ставим в плеер: ${next.title !== next.url ? next.title : next.url}`);
      return;
    }

    if (this.mode === 'injecting') {
      if (!st) return;
      const changed = st.found && (!this.preTuple || tuple(st) !== this.preTuple);
      if (changed) {
        this.mode = 'serving';
        this.servingTitle = st.title;
        this.servingArtist = st.artist;
        this.servingDur = st.durMs;
        this.servingStart = t;
        return;
      }
      if (t > this.injectDeadline && this.servingId !== null) {
        this.failItem(this.servingId, 'Плеер не отреагировал на запуск трека');
      }
      return;
    }

    // mode === 'serving'
    if (this.servingId === null) {
      this.mode = 'idle';
      return;
    }

    const elapsed = t - this.servingStart;
    const servingTuple = `${this.servingTitle} ${this.servingArtist}`;

    if (st && st.found && tuple(st) !== servingTuple) {
      // трек сменился: конец (радио/следующий) или ручной скип стримера
      const early = this.servingDur > 0 && elapsed < this.servingDur * 0.9;
      this.finish(early ? 'skipped' : 'done');
      return;
    }

    if (this.servingDur > 0) {
      if (st && st.found && st.playback === 'playing' && st.posMs >= this.servingDur - 2500) {
        this.finish('done');
        return;
      }
      if (elapsed > this.servingDur + 120_000) {
        this.finish('done');
        return;
      }
    } else if (elapsed > 300_000) {
      this.finish('done');
    }
  }

  private finish(status: 'done' | 'skipped'): void {
    if (this.servingId !== null) this.deps.queue.mark(this.servingId, status);
    this.servingId = null;
    this.mode = 'idle';
    this.nextAllowedAt = this.deps.now() + 1500;
  }

  private failItem(id: number, error: string): void {
    if (id >= 0) this.deps.queue.mark(id, 'failed', error);
    this.servingId = null;
    this.mode = 'idle';
    this.nextAllowedAt = this.deps.now() + 3000;
    this.fails += 1;
    const limit = this.deps.failLimit ?? 3;
    if (this.fails >= limit) {
      this.deps.setAutoplay?.(false);
      this.deps.onNotice(`⚠ Очередь остановлена: ${error}. Проверь, что Spotify установлен и запускается.`);
    } else {
      this.deps.onNotice(`⚠ ${error}`);
    }
  }

  resetFails(): void {
    this.fails = 0;
  }

  shouldStopAutoplay(): boolean {
    return this.fails >= (this.deps.failLimit ?? 3);
  }
}
