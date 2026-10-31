# TuneQueue 🎧

**Twitch song requests on Spotify. No API keys, no Premium, no servers, no subscriptions.**

A viewer posts `!sr <link>` in Twitch chat → the extension finds the track in the
open Spotify web player and clicks the native **“Add to queue”** button. The track plays
wherever the streamer listens — in the browser or in the Spotify desktop app (the queue is
shared across the account). After adding, the bot replies in chat:
`@user Queued [Artist - Track]`.

## Requirements

- Chrome / Edge / Opera (Manifest V3) or Firefox.
- The **open.spotify.com tab must stay open** (it can stay minimized — no focus stealing).
- Spotify Premium is **not** needed — the regular “Add to queue” button is free.

## Install

1. Unpack the release archive.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Enable **Developer mode**.
4. **Load unpacked** → select the `extension` folder.

Firefox: `about:debugging#/runtime/this-firefox` → “Load Temporary Add-on…” → pick `manifest.json`.

## One-time setup: Twitch application

Twitch sign-in requires a (free) application of your own — it takes 2 minutes, once:

1. Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → **Register Your Application**
   (Name: anything, e.g. `TuneQueue`; OAuth Redirect URL: any value, e.g. `https://localhost` —
   it is not used by the sign-in method).
2. Copy the **Client ID** and paste it into `extension/config.js`:
   ```js
   window.TQ_TWITCH_CLIENT_ID = 'ваш_client_id';
   ```
3. Reload the extension on the extensions page.

## Usage

1. Keep the **open.spotify.com** tab open (logged in to the streamer’s account).
2. Click the extension icon → **Authorize Twitch** → confirm on the Twitch page
   (“TuneQueue wants to access your account”). The bot joins your chat automatically.
3. Viewers request tracks:
   - `!sr https://open.spotify.com/track/…`
     (also `!play`, `!songrequest`, markdown `[x](x)`, `spotify:track:…`, short `spotify.link/…`)
4. The bot answers in chat: `@user Queued [Artist - Track]`.

Status in the popup: **bot in chat #yourname** — ready. Cooldown: 15 s per viewer;
requests are processed strictly in order.

## How it works

```
Twitch chat ──WebSocket──► content script (inside the open.spotify.com tab)
                              │  !sr <link>
                              ▼
              Search /tracks → exact track by ID → “⋮” → “Add to queue”
                              │  (ordinary clicks on Spotify's own UI)
                              ▼
                 Account queue → plays on any device
```

- No servers and no keys: chat uses a read/write OAuth token stored locally in the browser.
- Automation runs in a **background tab** — never raises a window or steals focus.
- If Spotify updates its interface, extend the selector candidate lists in `content.js`
  (`MORE_BTN_SEL` and friends) — the code logs each step to the browser console.

## Development

```bash
node --test tests/     # command parsing tests
```

Plain JS, no build step: `manifest.json`, `config.js`, `content.js`, `lib/parse.js`, `popup/`.

## License

MIT
