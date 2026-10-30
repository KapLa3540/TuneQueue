import {
  getChannelByTwitch,
  enqueue,
  listActive,
  listRecent,
  getQueueItem,
  setQueueStatus,
  type Channel,
} from '../db.js';
import {
  searchTrack,
  getTrackById,
  nextTrack,
  getPlayback,
  addToQueue,
  SpotifyApiError,
} from '../spotify/api.js';
import { ensureValidToken } from '../spotify/tokens.js';
import type { TwitchIrc } from './irc.js';
import type { Privmsg } from './irc.js';

const ADD_COOLDOWN_MS = 20_000;
const MAX_ACTIVE = 100;

const lastAdd = new Map<string, number>();

const SPOTIFY_TRACK_URL = /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)/;

function isMod(tags: Record<string, string>): boolean {
  const badges = tags.badges || '';
  return tags.mod === '1' || tags['user-type'] === 'mod' || badges.includes('broadcaster/') || badges.includes('mod/');
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createCommandHandler(irc: TwitchIrc) {
  async function handle(msg: Privmsg): Promise<void> {
    const { channel: ch, user, message, tags } = msg;
    const text = message.trim();
    if (!text.startsWith('!')) return;

    const spaceIdx = text.indexOf(' ');
    const cmd = (spaceIdx < 0 ? text : text.slice(0, spaceIdx)).toLowerCase();
    const arg = spaceIdx < 0 ? '' : text.slice(spaceIdx + 1).trim();

    const channel = getChannelByTwitch(ch);
    if (!channel) return; // канал не подключён к сервису — молчим

    try {
      switch (cmd) {
        case '!play':
        case '!req':
        case '!songrequest':
          await handlePlay(channel, user, arg, tags, (m) => irc.say(ch, m));
          break;
        case '!queue':
        case '!list':
          await handleQueue(channel, user, (m) => irc.say(ch, m));
          break;
        case '!np':
        case '!nowplaying':
        case '!song':
          await handleNowPlaying(channel, user, (m) => irc.say(ch, m));
          break;
        case '!skip':
        case '!next':
          await handleSkip(channel, user, tags, (m) => irc.say(ch, m));
          break;
      }
    } catch (err) {
      console.error(`[commands] error in #${ch}:`, err);
    }
  }

  async function handlePlay(
    channel: Channel,
    user: string,
    query: string,
    tags: Record<string, string>,
    reply: (m: string) => void,
  ): Promise<void> {
    if (!channel.spotify_user_id) {
      reply(`${user}, канал ещё не подключён к Spotify 🎧`);
      return;
    }
    if (!query) {
      reply(`${user}, напиши: !play название трека`);
      return;
    }
    if (listActive(channel.id).length >= MAX_ACTIVE) {
      reply(`${user}, очередь полна (${MAX_ACTIVE})`);
      return;
    }

    const cdKey = `${channel.id}:${user}`;
    const now = Date.now();
    const prev = lastAdd.get(cdKey) ?? 0;
    if (now - prev < ADD_COOLDOWN_MS) {
      reply(`${user}, подожди немного между запросами ⏳`);
      return;
    }

    const token = await ensureValidToken(channel);
    if (!token) {
      reply(`${user}, Spotify-авторизация канала истекла, переподключи её на сайте`);
      return;
    }

    // 1) Прямая ссылка на трек
    const urlMatch = query.match(SPOTIFY_TRACK_URL);
    let track = urlMatch ? await getTrackById(token, urlMatch[1]) : null;

    // 2) Поиск по названию
    if (!track) {
      track = await searchTrack(token, query);
    }
    if (!track) {
      reply(`${user}, ничего не нашёл по запросу «${query.slice(0, 40)}» 😕`);
      return;
    }

    lastAdd.set(cdKey, now);

    const item = enqueue(channel.id, {
      track_id: track.id,
      uri: track.uri,
      name: track.name,
      artists: track.artists,
      album_art: track.album_art,
      duration_ms: track.duration_ms,
      requested_by: user,
    });

    // Пытаемся сразу закинуть в очередь Spotify; если плеер офлайн —
    // фоновый свипер подтянет позже (трек уже в общей очереди).
    try {
      await addToQueue(token, track.uri);
      setQueueStatus(item.id, 'pushed');
      reply(`✅ ${user}: ${track.artists} — ${track.name} (${fmtDuration(track.duration_ms)})`);
    } catch (err) {
      if (err instanceof SpotifyApiError && err.reason === 'NO_ACTIVE_DEVICE') {
        reply(`⏳ ${user}: ${track.artists} — ${track.name} в очереди, плеер Spotify сейчас офлайн`);
      } else {
        const reason = err instanceof Error ? err.message : String(err);
        setQueueStatus(item.id, 'pending', reason);
        reply(`⏳ ${user}: ${track.name} в очереди (Spotify: ${reason})`);
      }
    }
  }

  async function handleQueue(
    channel: Channel,
    user: string,
    reply: (m: string) => void,
  ): Promise<void> {
    const items = listActive(channel.id).filter((i) => i.status !== 'playing').slice(0, 5);
    if (!items.length) {
      reply(`${user}, очередь пуста 🎵`);
      return;
    }
    const list = items
      .map((i, idx) => `${idx + 1}. ${i.artists} — ${i.name}`)
      .join(' | ');
    reply(`Очередь: ${list}`);
  }

  async function handleNowPlaying(
    channel: Channel,
    user: string,
    reply: (m: string) => void,
  ): Promise<void> {
    const token = await ensureValidToken(channel);
    if (!token) return;
    try {
      const pb = await getPlayback(token);
      if (!pb?.item) {
        reply(`${user}, сейчас ничего не играет`);
        return;
      }
      const artists = pb.item.artists.map((a) => a.name).join(', ');
      reply(`Сейчас играет: ${artists} — ${pb.item.name}`);
    } catch {
      /* тихо */
    }
  }

  async function handleSkip(
    channel: Channel,
    user: string,
    tags: Record<string, string>,
    reply: (m: string) => void,
  ): Promise<void> {
    if (!isMod(tags)) {
      reply(`${user}, пропускать могут только модераторы ⛔`);
      return;
    }
    const token = await ensureValidToken(channel);
    if (!token) return;
    try {
      await nextTrack(token);
      // Помечаем текущую игравшую запись как пропущенную (свипер всё синхронизирует)
      const playing = listActive(channel.id).find((i) => i.status === 'playing');
      if (playing) setQueueStatus(playing.id, 'skipped');
      reply(`⏭ Пропущено (${user})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      reply(`Не получилось пропустить: ${reason}`);
    }
  }

  return { handle };
}
