import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'crypto';
import { config } from '../config.js';
import {
  createChannel,
  getChannelBySetup,
  getChannelByTwitch,
  deleteChannel,
  saveSpotifyAuth,
  setSpotifyProfile,
  unlinkSpotify,
  listActive,
  listRecent,
  removeQueueItem,
  clearActiveQueue,
  queueCounts,
  resetQueueItem,
} from '../db.js';
import { createAuthState, buildAuthorizeUrl, exchangeCode } from '../spotify/auth.js';
import { ensureValidToken } from '../spotify/tokens.js';
import {
  getPlayback,
  getCurrentUser,
  nextTrack,
  previousTrack,
  setPlaying,
  SpotifyApiError,
} from '../spotify/api.js';
import type { TwitchIrc } from '../twitch/irc.js';

interface PendingAuth {
  verifier: string;
  setupToken: string;
  createdAt: number;
}

// verifier'ы живут в памяти между redirect'ами (достаточно для одного инстанса)
const authStates = new Map<string, PendingAuth>();

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of authStates) if (v.createdAt < cutoff) authStates.delete(k);
}, 3600_000).unref?.();

const CHANNEL_RE = /^[a-zA-Z0-9_]{3,25}$/;

export async function registerApi(app: FastifyInstance, irc: TwitchIrc): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, service: 'tunequeue' }));

  // --- создание канала ---

  app.post<{ Body: { channel?: string } }>('/api/channels', async (req, reply) => {
    const raw = (req.body?.channel ?? '').trim().toLowerCase();
    if (!CHANNEL_RE.test(raw)) {
      return reply.code(400).send({ error: 'Некорректный ник Twitch-канала' });
    }
    const existing = getChannelByTwitch(raw);
    if (existing) {
      if (existing.spotify_user_id) {
        return reply.code(409).send({
          error: 'Этот канал уже подключён. Если это ты — открой свою ссылку настройки из браузера.',
        });
      }
      // Канал создан, но Spotify ещё не подключён — возвращаем токен владельцу
      irc.join(existing.twitch_channel);
      return { channel: existing.twitch_channel, setup_token: existing.setup_token, reattached: true };
    }
    const ch = createChannel(raw);
    irc.join(ch.twitch_channel);
    return { channel: ch.twitch_channel, setup_token: ch.setup_token };
  });

  // --- статус канала ---

  app.get<{ Params: { token: string } }>('/api/channels/:token', async (req, reply) => {
    const ch = getChannelBySetup(req.params.token);
    if (!ch) return reply.code(404).send({ error: 'Не найдено' });

    const counts = queueCounts(ch.id);

    let playback: unknown = null;
    let playbackError: string | null = null;
    const token = await ensureValidToken(ch);
    if (token) {
      try {
        playback = await getPlayback(token);
      } catch (err) {
        playbackError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      channel: ch.twitch_channel,
      bot_joined: irc.has(ch.twitch_channel),
      bot_state: irc.joinState(ch.twitch_channel),
      bot_can_send: irc.canSend,
      spotify: {
        connected: Boolean(ch.spotify_user_id),
        display_name: ch.spotify_display_name,
      },
      counts,
      playback,
      playback_error: playbackError,
    };
  });

  app.delete<{ Params: { token: string } }>('/api/channels/:token', async (req, reply) => {
    const ch = getChannelBySetup(req.params.token);
    if (!ch) return reply.code(404).send({ error: 'Не найдено' });
    irc.part(ch.twitch_channel);
    deleteChannel(req.params.token);
    return { ok: true };
  });

  // --- Spotify OAuth (PKCE) ---

  app.get<{ Querystring: { token?: string } }>('/api/spotify/auth', async (req, reply) => {
    const token = req.query.token;
    const ch = token ? getChannelBySetup(token) : undefined;
    if (!ch) return reply.code(400).send({ error: 'Некорректный токен настройки' });
    if (!config.spotifyClientId) {
      return reply.code(500).send({ error: 'SPOTIFY_CLIENT_ID не настроен на сервере' });
    }
    const state = randomBytes(16).toString('hex');
    const auth = createAuthState();
    authStates.set(state, {
      verifier: auth.verifier,
      setupToken: ch.setup_token,
      createdAt: Date.now(),
    });
    return reply.redirect(buildAuthorizeUrl(state, auth));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/spotify/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;
      const fail = (e: string) =>
        reply.redirect(`${config.baseUrl}/?setup_error=${encodeURIComponent(e)}`);

      if (error || !code || !state) return fail(error || 'no_code');
      const pending = authStates.get(state);
      if (!pending) return fail('state_expired');
      authStates.delete(state);

      const ch = getChannelBySetup(pending.setupToken);
      if (!ch) return fail('channel_gone');

      try {
        const tokens = await exchangeCode(code, pending.verifier);
        const me = await getCurrentUser(tokens.access_token).catch(() => null);
        saveSpotifyAuth(
          ch.id,
          me?.id ?? 'unknown',
          me?.display_name ?? me?.id ?? 'Spotify',
          tokens.access_token,
          tokens.refresh_token ?? null,
          Date.now() + tokens.expires_in * 1000,
        );
        return reply.redirect(`${config.baseUrl}/?setup=${ch.setup_token}&linked=1`);
      } catch (err) {
        console.error('[spotify] callback error:', err);
        return fail('exchange_failed');
      }
    },
  );

  // --- очередь ---

  app.get<{ Params: { token: string } }>('/api/channels/:token/queue', async (req, reply) => {
    const ch = getChannelBySetup(req.params.token);
    if (!ch) return reply.code(404).send({ error: 'Не найдено' });
    const recent = listRecent(ch.id);
    const activeIds = new Set(listActive(ch.id).map((i) => i.id));
    return {
      items: recent.map((i) => ({ ...i, active: activeIds.has(i.id) })),
    };
  });

  app.delete<{ Params: { token: string; id: string } }>(
    '/api/channels/:token/items/:id',
    async (req, reply) => {
      const ch = getChannelBySetup(req.params.token);
      if (!ch) return reply.code(404).send({ error: 'Не найдено' });
      const ok = removeQueueItem(Number(req.params.id), ch.id);
      return ok ? { ok: true } : reply.code(404).send({ error: 'Не найдено' });
    },
  );

  app.post<{ Params: { token: string; id: string } }>(
    '/api/channels/:token/items/:id/retry',
    async (req, reply) => {
      const ch = getChannelBySetup(req.params.token);
      if (!ch) return reply.code(404).send({ error: 'Не найдено' });
      resetQueueItem(Number(req.params.id));
      return { ok: true };
    },
  );

  app.post<{ Params: { token: string } }>('/api/channels/:token/clear', async (req, reply) => {
    const ch = getChannelBySetup(req.params.token);
    if (!ch) return reply.code(404).send({ error: 'Не найдено' });
    const removed = clearActiveQueue(ch.id);
    return { ok: true, removed };
  });

  // --- управление плеером ---

  app.post<{ Params: { token: string; action: string } }>(
    '/api/channels/:token/control/:action',
    async (req, reply) => {
      const ch = getChannelBySetup(req.params.token);
      if (!ch) return reply.code(404).send({ error: 'Не найдено' });
      const token = await ensureValidToken(ch);
      if (!token) return reply.code(400).send({ error: 'Spotify не подключён' });

      try {
        switch (req.params.action) {
          case 'next':
            await nextTrack(token);
            break;
          case 'previous':
            await previousTrack(token);
            break;
          case 'play':
            await setPlaying(token, true);
            break;
          case 'pause':
            await setPlaying(token, false);
            break;
          default:
            return reply.code(400).send({ error: 'Неизвестное действие' });
        }
        return { ok: true };
      } catch (err) {
        if (err instanceof SpotifyApiError) {
          return reply.code(err.status >= 500 ? 502 : 400).send({
            error: err.message,
            reason: err.reason,
          });
        }
        throw err;
      }
    },
  );

  // обновить профиль Spotify (вызывается с фронта после подключения)
  app.post<{ Params: { token: string } }>(
    '/api/channels/:token/spotify/refresh-profile',
    async (req, reply) => {
      const ch = getChannelBySetup(req.params.token);
      if (!ch) return reply.code(404).send({ error: 'Не найдено' });
      const token = await ensureValidToken(ch);
      if (!token) return reply.code(400).send({ error: 'Токен недоступен' });
      const me = await getCurrentUser(token);
      if (me) setSpotifyProfile(ch.id, me.id, me.display_name || me.id);
      return { ok: true, me };
    },
  );
}
