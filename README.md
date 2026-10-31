# TuneQueue

**Song requests for Twitch on Spotify. No subscriptions, no bullshit.**

> 🇷🇺 [На русском](README.ru.md)

> ### ⭐ Основное направление — расширение для браузера
>
> **[extension/](extension/)** — зритель пишет `!sr <ссылка>` в Twitch-чат, расширение
> жмёт кнопку «Добавить в очередь» в открытом веб-плеере Spotify. Без API, Premium и серверов.
> Подробно: [extension/README.md](extension/README.md).
>
> Десктоп-приложение ([desktop/](desktop/)) — в архиве: работало, но воровало фокус окна
> и дублировало очередь Spotify. Код оставлен для истории.
>
> Веб-версия ниже — ранний прототип (веб-сервис с OAuth + Premium/плейлист).

Viewers write `!play` in your Twitch chat — the track lands in the queue and gets pushed
straight into your Spotify player. You control everything from one dashboard.

- 🎧 **Free & open source** (MIT). Self-host it or use a public instance — nobody pays, ever.
- 💬 **Chat commands**: `!play`, `!queue`, `!np`, `!skip` (mods only).
- 🎛 **Dashboard**: live queue, now playing, skip/pause/clear, request history.
- 🔗 **Just connect and go**: enter your channel name, link Spotify with OAuth (PKCE),
  the bot joins your chat automatically. No config files, no servers to set up.
- 🧩 **Multi-tenant**: one process serves many streamers (one IRC connection, per-channel queues).

## Requirements

| Thing | Why |
|---|---|
| **Spotify Premium** (of the linked account) | The official Spotify Web API only allows queue/playback control for Premium accounts. This is Spotify's restriction — there is no legal workaround. |
| A free Spotify Developer app | OAuth (created once, in the [Developer Dashboard](https://developer.spotify.com/dashboard)). |
| A Twitch bot account *(optional)* | Without a token the bot still **reads** chat and fulfills commands, it just can't reply in chat. With a token it answers in chat too. |

## Quick start

```bash
git clone <your-repo-url> tunequeue && cd tunequeue
npm install
cp .env.example .env      # fill in SPOTIFY_CLIENT_ID
npm run dev:web           # terminal 1 → frontend on :5173
npm run dev               # terminal 2 → API + bot on :8787
```

Open http://localhost:5173, enter your Twitch nick, click **Connect Spotify**.

**Spotify app settings:** add redirect URI `${BASE_URL}/api/spotify/callback`
(for dev: `http://localhost:5173/api/spotify/callback`).

### Production run

```bash
npm run build             # builds the frontend into dist/
npm start                 # one process serves API + frontend on :8787
```

Set `BASE_URL` to your public URL. Run it behind a reverse proxy with TLS (Caddy, nginx…),
keep `data/` on a persistent disk (SQLite). Works fine on any small VPS.

## Chat commands

| Command | Who | What |
|---|---|---|
| `!play <title or Spotify link>` | everyone | Search & queue a track (20 s cooldown per user, 100 max queue) |
| `!queue` | everyone | Show the next 5 tracks |
| `!np` / `!song` | everyone | What's playing right now |
| `!skip` / `!next` | mods & broadcaster | Skip to the next track |

## How it works

```
Twitch chat ──► IRC bot (ws) ──► local queue (SQLite) ──► Spotify Web API ──► your player
                     ▲                                          │
        dashboard (React) ◄── REST API (Fastify) ◄──────────────┘
```

- The local queue is the source of truth; a background sweeper (15 s) pushes `pending`
  tracks into Spotify as soon as a device comes online and reconciles played/skipped states.
- If your Spotify player is offline when someone requests a track, the request waits in
  the queue and is pushed automatically when you open Spotify and hit play.
- Setup access is a secret link (`/?setup=…`) stored in your browser — treat it like a password.

## Troubleshooting

- **"канал не найден на Twitch"** — Twitch silently ignores `JOIN` for nicknames that don't
  exist. Double-check the channel name.
- **Bot doesn't reply in chat** — set `TWITCH_BOT_NICK` + `TWITCH_BOT_OAUTH` (scopes
  `chat:read chat:edit`). Reading/fulfilling commands works even without this.
- **Requests stay `pending`** — no active Spotify device or the account isn't Premium;
  open Spotify, press play once.

## Roadmap

- [ ] Login with Twitch (proper ownership instead of secret links)
- [ ] Per-channel settings (mods-only requests, cooldowns, blocked artists)
- [ ] Webhooks / redeems (StreamElements, Nightbot import)
- [ ] Docker image + one-click deploy
- [ ] i18n (EN/RU)

## License

[MIT](LICENSE)
