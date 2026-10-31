# TuneQueue

**Twitch song requests on Spotify. No Premium, no API keys, no servers.**

> 🇷🇺 [На русском](README.ru.md)

## How it works

A viewer posts `!sr <link>` in Twitch chat → the extension — right inside the open
open.spotify.com tab — clicks Spotify's own **“Add to queue”** button, and the track
lands in the shared account queue: it plays wherever the streamer listens, in the
browser or in the Spotify app. After that the bot replies in chat:
`@user Queued [Artist - Track]`.

- **No Spotify Premium** — the regular “Add to queue” button is free.
- **No focus stealing** — all automation runs in a background tab, never raises a window.
- **No servers & no keys** — chat connects directly with a locally stored OAuth token.

## Install

See **[extension/README.md](extension/README.md)** — one-minute setup plus a one-time
Twitch authorization (“Authorize Twitch” button).

## Chat command

```
!sr https://open.spotify.com/track/…
```

That's the whole contract: one command, 15 s cooldown per viewer, requests are
processed strictly in order.

## Repository

| Path | What it is |
| --- | --- |
| [`extension/`](extension/) | **The product** — Manifest V3 browser extension, plain JS, no build step |
| `src/`, `web/`, `scripts/` | Early web prototype (archived) |

Tests: `node --test extension/tests/`

## Possible issues 
If when you press authorize only "..." appears without giving you code try to refresh your spotify browser page 

## License

[MIT](LICENSE)
