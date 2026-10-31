/* TuneQueue content script:
 * - connects to the streamer's Twitch chat (authed WebSocket after "Authorize Twitch");
 * - on !sr/!play <link> finds the track in Spotify and clicks the native
 *   "Add to queue" button via the UI (no Premium, no Web API);
 * - replies in chat: "@user Queued [Artist - Track]".
 * Runs in a background tab — never steals focus.
 */
(() => {
  'use strict';

  const P = window.TQParse;
  const ADD_COOLDOWN_MS = 15_000;

  // ---------- state ----------
  const state = { channel: '', enabled: true, connected: false, joined: false, joinRequestedAt: 0, busy: false };
  const cooldowns = new Map();
  const pending = [];

  function log(text) {
    console.debug('[TuneQueue]', text);
  }

  function persist() {
    try {
      chrome.storage.local.set({
        tq_status: {
          channel: state.channel,
          enabled: state.enabled,
          connected: state.connected,
          joined: state.joined,
          joinState: joinState(),
          busy: state.busy,
          pending: pending.length,
          nick: tw.nick,
          loggedIn: Boolean(tw.token && tw.nick),
        },
      });
    } catch (e) {
      /* ignore */
    }
  }

  function joinState() {
    if (state.joined) return 'joined';
    if (!state.connected || !state.channel) return 'none';
    return Date.now() - state.joinRequestedAt > 12_000 ? 'failed' : 'joining';
  }

  // ---------- Twitch account ----------
  const tw = { token: null, refresh: null, expires: 0, nick: null };
  const CLIENT_ID = window.TQ_TWITCH_CLIENT_ID || '';
  let lastSayAt = 0;

  function loadTwitchCreds(cb) {
    chrome.storage.local.get(['tq_twitch_token', 'tq_twitch_refresh', 'tq_twitch_expires', 'tq_twitch_nick'], (r) => {
      tw.token = r.tq_twitch_token || null;
      tw.refresh = r.tq_twitch_refresh || null;
      tw.expires = r.tq_twitch_expires || 0;
      tw.nick = r.tq_twitch_nick || null;
      if (cb) cb();
    });
  }

  function saveTwitchCreds() {
    chrome.storage.local.set({
      tq_twitch_token: tw.token,
      tq_twitch_refresh: tw.refresh,
      tq_twitch_expires: tw.expires,
      tq_twitch_nick: tw.nick,
    });
  }

  async function fetchTwitchLogin(token) {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const d = await res.json();
    return (d.data && d.data[0] && d.data[0].login) || null;
  }

  async function refreshTwitchToken() {
    if (!tw.token || !tw.refresh) return;
    if (tw.expires && tw.expires - Date.now() > 60_000) return;
    try {
      const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: tw.refresh,
        }).toString(),
      });
      if (!res.ok) return;
      const b = await res.json();
      if (!b.access_token) return;
      tw.token = b.access_token;
      tw.refresh = b.refresh_token || tw.refresh;
      tw.expires = b.expires_in ? Date.now() + b.expires_in * 1000 : 0;
      saveTwitchCreds();
      restartChat();
    } catch (e) {
      /* ignore */
    }
  }

  /** Sign in with Twitch (device code flow, one button in the popup). */
  let deviceGen = 0;

  async function beginTwitchLogin() {
    if (!CLIENT_ID) {
      throw new Error('Twitch app Client ID is not set — see extension/config.js');
    }
    const res = await fetch('https://id.twitch.tv/oauth2/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, scopes: 'chat:read chat:edit' }).toString(),
    });
    if (!res.ok) throw new Error('Twitch device endpoint: HTTP ' + res.status);
    const info = await res.json();
    const dev = {
      user_code: info.user_code,
      verification_uri: info.verification_uri,
      verification_uri_complete: info.verification_uri_complete || info.verification_uri,
      device_code: info.device_code,
      interval: info.interval || 5,
      expiresAt: Date.now() + (info.expires_in || 1800) * 1000,
      status: 'waiting',
    };
    chrome.storage.local.set({ tq_device: dev });
    log('Twitch: enter the code at ' + info.verification_uri);
    const gen = ++deviceGen;
    void pollDevice(dev, gen);
    return dev;
  }

  async function pollDevice(dev, gen) {
    if (gen !== deviceGen) return;
    if (Date.now() > dev.expiresAt) {
      chrome.storage.local.set({ tq_device: { status: 'expired' } });
      log('Twitch: code expired');
      return;
    }
    try {
      const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          scopes: 'chat:read chat:edit',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: dev.device_code,
        }).toString(),
      });
      const body = await res.json().catch(() => ({}));
      const msg = String(body.message || body.error || '').toLowerCase();

      if (msg.includes('authorization_pending') || res.status === 428) {
        setTimeout(() => void pollDevice(dev, gen), Math.max(1, dev.interval) * 1000);
        return;
      }
      if (msg.includes('slow_down')) {
        dev.interval = Math.max(1, dev.interval) + 5;
        setTimeout(() => void pollDevice(dev, gen), dev.interval * 1000);
        return;
      }
      if (!body.access_token) {
        chrome.storage.local.set({ tq_device: { status: 'error', error: msg || 'HTTP ' + res.status } });
        log('Twitch login error: ' + (msg || res.status));
        return;
      }

      // success
      tw.token = body.access_token;
      tw.refresh = body.refresh_token || null;
      tw.expires = body.expires_in ? Date.now() + body.expires_in * 1000 : 0;
      const nick = await fetchTwitchLogin(tw.token);
      if (!nick) throw new Error('could not get the Twitch login');
      tw.nick = nick;
      saveTwitchCreds();
      chrome.storage.local.set({ tq_device: { status: 'done', nick } });
      log('Twitch: connected as @' + nick);
      startChatForNick(nick);
      persist();
    } catch (e) {
      chrome.storage.local.set({ tq_device: { status: 'error', error: String(e && e.message) } });
      log('Twitch login error: ' + (e && e.message ? e.message : e));
    }
  }

  /** Chat reply from the streamer's account. */
  async function say(text) {
    if (!tw.token || !tw.nick || !state.channel) {
      log('not replying (Twitch not connected): ' + text);
      return;
    }
    await refreshTwitchToken();
    const now = Date.now();
    if (now - lastSayAt < 1300) {
      setTimeout(() => void say(text), 1400);
      return;
    }
    lastSayAt = now;
    ircSend('PRIVMSG #' + state.channel + ' :' + text);
  }

  // ---------- Twitch IRC (authed only) ----------
  let ws = null;
  let stopped = true;
  let ready = false;
  let backoff = 1000;
  let myNick = '';

  function startChatForNick(nick) {
    state.channel = String(nick).toLowerCase();
    chatDisconnect();
    stopped = true;
    chatConnect();
    log('connecting to #' + state.channel + '…');
    persist();
  }

  function chatConnect() {
    if (!stopped) return;
    if (!tw.token || !tw.nick || !state.channel) return;
    stopped = false;
    openWs();
  }

  function chatDisconnect() {
    stopped = true;
    ready = false;
    state.connected = false;
    state.joined = false;
    try {
      if (ws) ws.close();
    } catch (e) {
      /* ignore */
    }
    ws = null;
    persist();
  }

  function restartChat() {
    chatDisconnect();
    stopped = true;
    if (state.channel && tw.token) chatConnect();
  }

  function ircSend(line) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(line + '\r\n');
  }

  function openWs() {
    if (stopped || !state.channel) return;
    let sock;
    try {
      sock = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    } catch (e) {
      log('cannot open WebSocket to Twitch: ' + e.message);
      return;
    }
    ws = sock;

    sock.addEventListener('open', () => {
      myNick = String(tw.nick).toLowerCase();
      ircSend('PASS oauth:' + String(tw.token).replace(/^oauth:/, ''));
      ircSend('NICK ' + myNick);
      ircSend('CAP REQ :twitch.tv/tags twitch.tv/commands');
    });

    sock.addEventListener('message', (ev) => {
      for (const line of String(ev.data).split('\r\n')) {
        if (line) handleLine(line);
      }
    });

    sock.addEventListener('close', () => {
      ready = false;
      state.connected = false;
      state.joined = false;
      persist();
      if (stopped) return;
      setTimeout(openWs, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });

    sock.addEventListener('error', () => {
      /* close follows */
    });
  }

  function handleLine(line) {
    if (line.startsWith('PING')) {
      ircSend(line.replace('PING', 'PONG'));
      return;
    }
    if (/^:tmi\.twitch\.tv\s+001\s/.test(line)) {
      ready = true;
      backoff = 1000;
      state.connected = true;
      state.joinRequestedAt = Date.now();
      log('chat connected as @' + myNick + ' (#' + state.channel + ')');
      ircSend('JOIN #' + state.channel);
      persist();
      return;
    }
    if (line.includes(' NOTICE ') && /Login authentication failed|Improperly formatted auth/i.test(line)) {
      log('Twitch token rejected — disconnecting the account');
      tw.token = null;
      tw.nick = null;
      saveTwitchCreds();
      chrome.storage.local.set({ tq_device: { status: 'error', error: 'Twitch rejected the login — try again' } });
      restartChat();
      persist();
      return;
    }
    const sp = line.indexOf(' ');
    const prefix = line.startsWith(':') ? line.slice(1, sp < 0 ? undefined : sp) : '';
    const rest = line.slice(sp + 1);
    const nick = prefix.split('!')[0];
    if (nick && nick.toLowerCase() === myNick && rest.startsWith('JOIN #')) {
      state.joined = true;
      log('bot joined #' + state.channel);
      persist();
      return;
    }
    if (line.includes(' PRIVMSG ')) {
      const msg = parsePrivmsg(line);
      if (msg) onChatMessage(msg.user, msg.message);
    }
  }

  function parsePrivmsg(line) {
    let rest = line;
    if (rest.startsWith('@')) {
      const i = rest.indexOf(' ');
      if (i < 0) return null;
      rest = rest.slice(i + 1);
    }
    if (!rest.startsWith(':')) return null;
    const sp1 = rest.indexOf(' ');
    if (sp1 < 0) return null;
    const prefix = rest.slice(1, sp1);
    rest = rest.slice(sp1 + 1);
    const sp2 = rest.indexOf(' ');
    if (sp2 < 0) return null;
    if (rest.slice(0, sp2) !== 'PRIVMSG') return null;
    let params = rest.slice(sp2 + 1);
    if (params.startsWith(':')) params = params.slice(1);
    const sp3 = params.indexOf(' ');
    if (sp3 < 0) return null;
    return { user: prefix.split('!')[0], message: params.slice(sp3 + 1) };
  }

  // ---------- chat commands ----------
  function onChatMessage(user, rawText) {
    if (!state.enabled) return;
    const cmd = P.normalizeCommand(rawText);
    if (!cmd) return;
    if (!cmd.known) return;
    if (!cmd.rest) {
      log('@' + user + ' posted the command without a link');
      return;
    }

    let track = P.extractSpotifyTrack(cmd.rest);
    if (!track) {
      const urlTok = (cmd.rest.match(/https?:\/\/\S+/) || [''])[0].replace(/[),.;!?'"\]]+$/, '');
      if (urlTok && P.isSpotifyShortLink(urlTok)) {
        log('resolving a short link…');
        void resolveShort(urlTok).then((t) => {
          if (t) enqueue(t, user);
          else log('short link did not resolve');
        });
        return;
      }
      log('@' + user + ' posted no Spotify track link');
      return;
    }

    if (!P.cooldownAllows(cooldowns, state.channel + ':' + user, Date.now(), ADD_COOLDOWN_MS)) {
      log('cooldown for @' + user + ' — skipped');
      return;
    }
    enqueue(track, user);
  }

  async function resolveShort(url) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      return P.extractSpotifyTrack(res.url);
    } catch (e) {
      return null;
    }
  }

  function enqueue(track, by) {
    const job = { trackId: track.trackId, url: track.url, title: '', artist: '', by: by, attempts: 0 };
    pending.push(job);
    log('queued request from @' + by + ' (extension queue: ' + pending.length + ')');
    void fetchMeta(job);
    void processQueue();
  }

  async function fetchMeta(job) {
    try {
      const res = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(job.url));
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.title) {
        job.title = data.title;
        job.artist = data.author_name || '';
      }
    } catch (e) {
      /* metadata is best-effort */
    }
  }

  // ---------- adding to the queue via Spotify's own UI ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(fn, timeoutMs, stepMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      (function poll() {
        let v = null;
        try {
          v = fn();
        } catch (e) {
          /* ignore */
        }
        if (v) return resolve(v);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(poll, stepMs || 120);
      })();
    });
  }

  function click(el) {
    if (!el) return false;
    try {
      el.scrollIntoView && el.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      /* ignore */
    }
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();
    return true;
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
  }

  /* Selector candidates. If Spotify updates the UI — extend these lists here. */
  const MORE_BTN_SEL = [
    'button[data-testid="more-button"]',
    'button[aria-label*="More options" i]',
    'button[aria-label*="Ещё" i]',
    'button[aria-label*="Weitere Optionen" i]',
    'button[aria-label*="Más opciones" i]',
    'button[aria-label*="plus d’options" i]',
    'button[aria-label*="opzioni" i]',
  ].join(', ');

  function findMoreButtonGlobal() {
    const nodes = document.querySelectorAll(MORE_BTN_SEL);
    for (const b of nodes) {
      if (b.closest('footer')) continue; // bottom player — not this
      if (b.closest('[data-testid="now-playing-widget"]')) continue;
      return b;
    }
    return null;
  }

  /* Main path — same as the proven open-source implementation (Oct'26):
   * SPA-navigate to /search/{query}/tracks → exact track by ID in the link →
   * [data-testid="more-button"] in its row → [role="menu"] → "Add to queue" by text. */
  function navigateSpaTo(pathWithQuery) {
    const dest = pathWithQuery;
    if (dest !== location.pathname + location.search + location.hash) {
      const hist = { ...(window.history.state || {}), key: Math.random().toString(36).slice(2, 10) };
      if (Number.isInteger(hist.idx)) hist.idx += 1;
      window.history.pushState(hist, '', dest);
      window.dispatchEvent(new PopStateEvent('popstate', { state: hist }));
      return true;
    }
    return false;
  }

  function findTrackLinkLoose(job) {
    for (const link of document.querySelectorAll('main a[href*="/track/"]')) {
      try {
        if (new URL(link.href, location.origin).pathname === '/track/' + job.trackId) return link;
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  function findMoreInRowNear(link) {
    let el = link;
    for (let i = 0; i < 6 && el; i++) {
      el = el.parentElement;
      if (!el || !el.querySelector) break;
      const btn = el.querySelector('button[data-testid="more-button"]');
      if (btn) return btn;
    }
    return null;
  }

  function findQueueMenuItem(job) {
    const menus = document.querySelectorAll('[role="menu"]');
    // validated first: the menu must belong to our track (highlight link in its header)
    for (const menu of menus) {
      let owns = false;
      for (const l of menu.querySelectorAll('a[href]')) {
        try {
          if (new URL(l.href, location.origin).searchParams.get('highlight') === 'spotify:track:' + job.trackId) {
            owns = true;
          }
        } catch (e) {
          /* ignore */
        }
      }
      if (!owns && job.title) {
        const txt = menu.textContent || '';
        if (txt.indexOf(job.title) >= 0) owns = true;
      }
      if (!owns) continue;
      for (const b of menu.querySelectorAll('button, [role="menuitem"], [role="menuitemcheckbox"]')) {
        if (P.matchAddToQueue(b.textContent || b.getAttribute('aria-label') || '')) return b;
      }
    }
    // fallback: any open menu, first matching label
    for (const b of document.querySelectorAll('[role="menu"] button, [role="menu"] [role="menuitem"]')) {
      if (P.matchAddToQueue(b.textContent || b.getAttribute('aria-label') || '')) return b;
    }
    return null;
  }

  function dumpDiagnostics() {
    try {
      const moreBtns = document.querySelectorAll('button[data-testid="more-button"]').length;
      const links = document.querySelectorAll('main a[href*="/track/"]').length;
      log('diagnostics: more-buttons=' + moreBtns + ', track-links=' + links + ', path=' + location.pathname.slice(0, 48));
    } catch (e) {
      /* ignore */
    }
  }

  function dumpMenuTexts() {
    try {
      const menus = document.querySelectorAll('[role="menu"]');
      if (!menus.length) {
        log('the menu did not open at all');
        return;
      }
      const texts = Array.from(menus[menus.length - 1].querySelectorAll('button, [role="menuitem"]'))
        .slice(0, 12)
        .map((b) => (b.textContent || '').trim().slice(0, 32))
        .filter(Boolean);
      log('"Add to queue" not found; menu items: ' + texts.join(' | ').slice(0, 300));
    } catch (e) {
      log('menu could not be parsed');
    }
  }

  async function addTrackToQueueUI(job) {
    // Path 1 (main): search with an exact ID match
    let ok = await queueViaSearch(job);
    // Path 2: the track page
    if (!ok) {
      log('search path failed — trying the track page');
      ok = await queueViaTrackPage(job);
    }
    if (!ok) dumpDiagnostics();
    return ok;
  }

  async function queueViaSearch(job) {
    const startHref = location.href;
    const startKey = window.history.state && window.history.state.key;
    const q = encodeURIComponent(((job.title || '') + ' ' + (job.artist || '')).trim() || job.trackId);
    log('step: searching the track in Spotify (/tracks)');
    navigateSpaTo('/search/' + q + '/tracks');
    // if pushState did not move the app — click a link
    await sleep(300);
    if (!location.pathname.startsWith('/search')) {
      const a = document.createElement('a');
      a.href = 'https://open.spotify.com/search/' + q + '/tracks';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    const arrived = await waitFor(() => location.pathname.startsWith('/search'), 5000);
    if (!arrived) {
      log('the search page did not open');
      return false;
    }
    await sleep(1000);

    const linkSel = 'main [data-testid="infinite-scroll-list"] a[href*="/track/' + job.trackId + '"]';
    const link = await waitFor(() => document.querySelector(linkSel) || findTrackLinkLoose(job), 8000);
    if (!link) {
      log('the exact track was not found in the search results');
      return false;
    }
    log('step: exact track found in the results');

    const row = link.closest('[data-testid="tracklist-row"], [role="row"], [data-testid="entityRow"]');
    let more = (row && row.querySelector('button[data-testid="more-button"]')) || null;
    if (!more) more = findMoreInRowNear(link);
    if (!more) more = await waitFor(findMoreButtonGlobal, 2500);
    if (!more) {
      log('the "⋮" button was not found next to the track row');
      return false;
    }

    click(more);
    log('step: opened the track menu');
    const item = await waitFor(() => findQueueMenuItem(job), 4500);
    if (!item) {
      dumpMenuTexts();
      pressEscape();
      pressEscape();
      return false;
    }
    click(item);
    log('step: clicked "Add to queue"');
    await sleep(400);
    pressEscape();
    pressEscape();

    if (location.href !== startHref && window.history.state && window.history.state.key === startKey) {
      history.back();
      log('step: restored the previous view');
    }
    return true;
  }

  async function queueViaTrackPage(job) {
    const startHref = location.href;
    const startKey = window.history.state && window.history.state.key;

    const a = document.createElement('a');
    a.href = '/track/' + job.trackId;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    const ok = await waitFor(() => location.pathname.indexOf('/track/' + job.trackId) >= 0, 5000);
    if (!ok) {
      log('the track page did not open');
      return false;
    }
    await sleep(1200);
    log('step: opened the track page');

    let more = await waitFor(findMoreButtonGlobal, 5000);
    if (!more) {
      const titleLink = await waitFor(
        () => document.querySelector('[data-testid="context-item-info-title"] a') || document.querySelector('main h1'),
        2000,
      );
      if (titleLink) more = findMoreInRowNear(titleLink) || findMoreInRowNear(titleLink.parentElement || titleLink);
    }
    if (!more) {
      log('the "⋮" button was not found on the track page');
      return false;
    }

    click(more);
    log('step: opened the track menu');
    const item = await waitFor(() => findQueueMenuItem(job), 4500);
    if (!item) {
      dumpMenuTexts();
      pressEscape();
      pressEscape();
      return false;
    }
    click(item);
    log('step: clicked "Add to queue"');
    await sleep(400);
    pressEscape();
    pressEscape();

    if (location.href !== startHref && window.history.state && window.history.state.key === startKey) {
      history.back();
      log('step: restored the previous view');
    }
    return true;
  }

  async function processQueue() {
    if (state.busy) return;
    const job = pending[0];
    if (!job) return;
    state.busy = true;
    persist();
    try {
      if (!job.title) await fetchMeta(job);
      log('adding to the Spotify queue: ' + (job.title || job.trackId));
      const ok = await addTrackToQueueUI(job);
      if (ok) {
        pending.shift();
        const name = job.artist ? job.artist + ' - ' + job.title : job.title || job.url;
        log('added to the Spotify queue: ' + name);
        void say('@' + job.by + ' Queued [' + name + ']');
      } else {
        job.attempts = (job.attempts || 0) + 1;
        if (job.attempts >= 3) {
          pending.shift();
          log('giving up: ' + (job.title || job.url));
        }
        await sleep(4000);
      }
    } catch (e) {
      log('error: ' + (e && e.message ? e.message : String(e)));
    } finally {
      state.busy = false;
      persist();
      if (pending.length) setTimeout(() => void processQueue(), 1200);
    }
  }

  // ---------- settings ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.tq_enabled) {
      state.enabled = Boolean(changes.tq_enabled.newValue);
      log(state.enabled ? 'extension enabled' : 'extension disabled');
      persist();
    }
    if ('tq_twitch_login_request' in changes) {
      beginTwitchLogin().catch((e) => {
        chrome.storage.local.set({ tq_device: { status: 'error', error: String(e && e.message ? e.message : e) } });
      });
    }
    if (changes.tq_twitch_token && !changes.tq_twitch_token.newValue) {
      // signed out from the popup
      if (tw.token || tw.nick) log('Twitch: account disconnected');
      tw.token = null;
      tw.nick = null;
      tw.refresh = null;
      state.channel = '';
      chatDisconnect();
      persist();
    }
    if (changes.tq_twitch_token && changes.tq_twitch_token.newValue && changes.tq_twitch_token.newValue !== tw.token) {
      loadTwitchCreds(() => {
        if (tw.nick) startChatForNick(tw.nick);
      });
    }
  });

  // ---------- boot ----------
  loadTwitchCreds(() => {
    chrome.storage.local.get(['tq_enabled'], (r) => {
      state.enabled = r.tq_enabled !== false;
      log('content script started on ' + location.host);
      if (tw.token && tw.nick) {
        log('Twitch account present: @' + tw.nick);
        startChatForNick(tw.nick);
      } else {
        persist();
      }
    });
  });
})();
