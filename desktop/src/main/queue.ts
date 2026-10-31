import type { QueueItem, ItemStatus } from '../shared/types.js';

const TRACK_URL_RE = /^(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})(?:[/?#].*)?$/i;
const TRACK_URI_RE = /^spotify:track:([A-Za-z0-9]{22})$/i;

export interface ParsedTrack {
  trackId: string;
  url: string;
}

/** Принимаем только ссылки на трек Spotify (https://open.spotify.com/track/... или spotify:track:...). */
export function parseSpotifyTrack(input: string): ParsedTrack | null {
  const s = input.trim().replace(/[),.;!?'"\]]+$/, '');
  const url = s.match(TRACK_URL_RE);
  if (url) {
    const trackId = url[1];
    return { trackId, url: `https://open.spotify.com/track/${trackId}` };
  }
  const uri = s.match(TRACK_URI_RE);
  if (uri) {
    const trackId = uri[1];
    return { trackId, url: `https://open.spotify.com/track/${trackId}` };
  }
  return null;
}

export const COOLDOWN_MS = 15_000;
export const MAX_ACTIVE = 100;

export interface AddResult {
  ok: boolean;
  item?: QueueItem;
  reason?: 'cooldown' | 'full';
}

export class QueueService {
  private items: QueueItem[] = [];
  private nextId = 1;
  private lastAdd = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  add(track: ParsedTrack, by: string, channelKey: string): AddResult {
    const t = this.now();
    const cdKey = `${channelKey}:${by}`;
    const prev = this.lastAdd.get(cdKey) ?? 0;
    if (t - prev < COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
    if (this.active().length >= MAX_ACTIVE) return { ok: false, reason: 'full' };

    this.lastAdd.set(cdKey, t);
    const item: QueueItem = {
      id: this.nextId++,
      trackId: track.trackId,
      url: track.url,
      title: track.url,
      artist: '',
      thumb: null,
      by,
      status: 'queued',
      error: null,
      at: t,
      playedAt: null,
    };
    this.items.push(item);
    return { ok: true, item };
  }

  enrich(id: number, title: string, artist: string, thumb: string | null): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'queued') return;
    if (item.title !== item.url) return; // уже обогащён
    item.title = title;
    item.artist = artist;
    item.thumb = thumb;
  }

  get(id: number): QueueItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  firstQueued(): QueueItem | undefined {
    return this.items.find((i) => i.status === 'queued');
  }

  mark(id: number, status: ItemStatus, error: string | null = null): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    item.status = status;
    item.error = error;
    if (status === 'done' || status === 'skipped' || status === 'failed') item.playedAt = this.now();
  }

  remove(id: number): boolean {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    if (this.items[idx].status === 'playing') return false; // сейчас играет — не трогаем
    this.items.splice(idx, 1);
    return true;
  }

  clearFinished(): number {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.status !== 'done' && i.status !== 'skipped' && i.status !== 'failed');
    return before - this.items.length;
  }

  clearQueued(): number {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.status !== 'queued');
    return before - this.items.length;
  }

  active(): QueueItem[] {
    return this.items.filter((i) => i.status === 'queued' || i.status === 'playing');
  }

  all(): QueueItem[] {
    return [...this.items];
  }

  queuedCount(): number {
    return this.items.filter((i) => i.status === 'queued').length;
  }
}
