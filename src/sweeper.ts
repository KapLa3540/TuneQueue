import {
  getAllChannels,
  listPending,
  listActive,
  setQueueStatus,
  bumpAttempts,
  trimPlayedItems,
} from './db.js';
import { ensureValidToken } from './spotify/tokens.js';
import { addToQueue, getPlayback, SpotifyApiError, type Playback } from './spotify/api.js';

const TICK_MS = 15_000;
const PUSH_BATCH = 5;
const MAX_ATTEMPTS = 20;

/**
 * Каждые 15 секунд:
 *  1) сверяет локальную очередь с реальным плеером Spotify (playing/played);
 *  2) допихивает pending-треки в очередь Spotify, когда плеер снова онлайн.
 */
async function tick(): Promise<void> {
  for (const channel of getAllChannels()) {
    if (!channel.spotify_user_id || !channel.access_token) continue;
    try {
      const token = await ensureValidToken(channel);
      if (!token) continue;

      let playback: Playback | null = null;
      try {
        playback = await getPlayback(token);
      } catch {
        playback = null;
      }

      reconcile(channel.id, playback);

      if (playback?.device) {
        await pushPending(channel.id, token, playback);
      }

      trimPlayedItems(channel.id);
    } catch (err) {
      console.error(`[sweeper] #${channel.twitch_channel}:`, err);
    }
  }
}

/** Синхронизация статусов: что сейчас играет, что уже доиграло. */
function reconcile(channelId: number, playback: Playback | null): void {
  const items = listActive(channelId);
  if (!items.length) return;

  const currentUri = playback?.item?.uri ?? null;
  const playing = items.find((i) => i.status === 'playing');

  if (currentUri) {
    const nowPlaying = items.find((i) => i.uri === currentUri && i.status !== 'playing');

    // Трек, который был playing, но больше не играет — доиграл
    if (playing && playing.uri !== currentUri) {
      setQueueStatus(playing.id, 'played');
    }
    if (nowPlaying) {
      setQueueStatus(nowPlaying.id, 'playing');
      // всё, что стояло в очереди перед ним — уже сыграно
      for (const i of items) {
        if (i.id < nowPlaying.id && (i.status === 'pending' || i.status === 'pushed')) {
          setQueueStatus(i.id, 'played');
        }
      }
    }
  } else if (playing) {
    // Плеер остановлен — помечаем как доигравший
    setQueueStatus(playing.id, 'played');
  }
}

/** Дозакидывает pending-треки в очередь Spotify по порядку. */
async function pushPending(
  channelId: number,
  token: string,
  playback: Playback,
): Promise<void> {
  const pending = listPending(channelId);
  for (const item of pending.slice(0, PUSH_BATCH)) {
    try {
      await addToQueue(token, item.uri);
      setQueueStatus(item.id, 'pushed');
    } catch (err) {
      const attempts = item.attempts + 1;
      if (err instanceof SpotifyApiError && err.reason === 'NO_ACTIVE_DEVICE') {
        // плеер ушёл — не фатально, попробуем в следующий тик
        break;
      }
      bumpAttempts(item.id);
      if (err instanceof SpotifyApiError) {
        if (attempts >= MAX_ATTEMPTS) {
          setQueueStatus(item.id, 'failed', `${err.status}: ${err.message}`);
        } else {
          setQueueStatus(item.id, 'pending', err.message);
        }
      } else if (attempts >= MAX_ATTEMPTS) {
        setQueueStatus(item.id, 'failed', err instanceof Error ? err.message : String(err));
      }
      break; // прекращаем серию при ошибке, чтобы не ломать порядок
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSweeper(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  console.log(`[sweeper] started, interval ${TICK_MS}ms`);
}

export function stopSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
