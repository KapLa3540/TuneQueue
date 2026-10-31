/* TuneQueue content script:
 * 1) слушает чат Twitch напрямую (WebSocket) — анонимно или с токеном стримера;
 * 2) по !sr/!play <ссылка> сам находит трек в Spotify и жмёт «Добавить в очередь»;
 * 3) после успеха отвечает в чате: «@user Queued [трек]» (если Twitch подключён).
 * Работает в фоновой вкладке — окно/игру не поднимает.
 */
(() => {
  'use strict';

  const P = window.TQParse;
  const ADD_COOLDOWN_MS = 15_000;
  const MAX_EVENTS = 60;

  // ---------- состояние ----------
  const state = {
    channel: '',
    enabled: true,
    connected: false,
    joined: false,
    joinRequestedAt: 0,
    busy: false,
    events: [],
  };
  const cooldowns = new Map();
  const pending = [];

  function log(text) {
    state.events.push({ t: Date.now(), text });
    if (state.events.length > MAX_EVENTS) state.events.shift();
    persist();
  }

  function persist() {
    try {
      chrome.storage.local.set({
        tq_events: state.events,
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

  // ---------- аккаунт Twitch (для ответов в чате) ----------
  const tw = { token: null, refresh: null, expires: 0, nick: null, clientId: '' };
  let lastSayAt = 0;
  let replySilentLogged = false;

  function loadTwitchCreds(cb) {
    chrome.storage.local.get(
      ['tq_twitch_client_id', 'tq_twitch_token', 'tq_twitch_refresh', 'tq_twitch_expires', 'tq_twitch_nick'],
      (r) => {
        tw.clientId = r.tq_twitch_client_id || '';
        tw.token = r.tq_twitch_token || null;
        tw.refresh = r.tq_twitch_refresh || null;
        tw.expires = r.tq_twitch_expires || 0;
        tw.nick = r.tq_twitch_nick || null;
        if (cb) cb();
      },
    );
  }

  function saveTwitchCreds(patch) {
    chrome.storage.local.set({
      tq_twitch_token: tw.token,
      tq_twitch_refresh: tw.refresh,
      tq_twitch_expires: tw.expires,
      tq_twitch_nick: tw.nick,
      ...patch,
    });
  }

  async function fetchTwitchLogin(clientId, token) {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': clientId, Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const d = await res.json();
    return (d.data && d.data[0] && d.data[0].login) || null;
  }

  async function refreshTwitchToken() {
    if (!tw.token || !tw.clientId) return;
    if (tw.expires && tw.expires - Date.now() > 60_000) return;
    if (!tw.refresh) return;
    try {
      const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: tw.clientId,
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
      saveTwitchCreds({});
      restartChat(); // новый токен → переподключаем IRC с новым PASS
    } catch (e) {
      /* ignore */
    }
  }

  /** Вход Twitch по Device Code. */
  let deviceGen = 0;

  async function beginTwitchLogin() {
    if (!tw.clientId) throw new Error('Сначала сохрани Client ID приложения Twitch');
    const res = await fetch('https://id.twitch.tv/oauth2/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: tw.clientId, scopes: 'chat:read chat:edit' }).toString(),
    });
    if (!res.ok) throw new Error('Twitch device endpoint: HTTP ' + res.status);
    const info = await res.json();
    const dev = {
      user_code: info.user_code,
      verification_uri: info.verification_uri,
      device_code: info.device_code,
      interval: info.interval || 5,
      expiresAt: Date.now() + (info.expires_in || 1800) * 1000,
      status: 'waiting',
    };
    chrome.storage.local.set({ tq_device: dev });
    log('Twitch: введи код на ' + info.verification_uri);
    const gen = ++deviceGen;
    void pollDevice(dev, gen);
    return dev;
  }

  async function pollDevice(dev, gen) {
    if (gen !== deviceGen) return;
    if (Date.now() > dev.expiresAt) {
      chrome.storage.local.set({ tq_device: { status: 'expired' } });
      log('Twitch: код истёк');
      return;
    }
    try {
      const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: tw.clientId,
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
        log('Twitch: ошибка входа: ' + (msg || res.status));
        return;
      }

      // успех
      tw.token = body.access_token;
      tw.refresh = body.refresh_token || null;
      tw.expires = body.expires_in ? Date.now() + body.expires_in * 1000 : 0;
      const nick = await fetchTwitchLogin(tw.clientId, tw.token);
      if (!nick) throw new Error('не удалось получить логин Twitch');
      tw.nick = nick;
      saveTwitchCreds({});
      chrome.storage.local.set({ tq_device: { status: 'done', nick } });
      log('Twitch: подключены как @' + nick + ' — теперь отвечаем в чате');
      restartChat();
    } catch (e) {
      chrome.storage.local.set({ tq_device: { status: 'error', error: String(e && e.message) } });
      log('Twitch: ошибка входа: ' + (e && e.message ? e.message : e));
    }
  }

  /** Ответ в чат от имени стримера. */
  async function say(text) {
    if (!tw.token || !tw.nick) {
      if (!replySilentLogged) {
        replySilentLogged = true;
        log('ℹ в чат не ответили (Twitch не подключён): ' + text);
      }
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

  // ---------- Twitch IRC ----------
  let ws = null;
  let stopped = true;
  let ready = false;
  let backoff = 1000;
  let myNick = '';

  function chatConnect() {
    if (!stopped) return;
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
    if (state.channel) chatConnect();
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
      log('✗ не удалось открыть WebSocket к Twitch: ' + e.message);
      return;
    }
    ws = sock;

    sock.addEventListener('open', () => {
      if (tw.token && tw.nick) {
        myNick = String(tw.nick).toLowerCase();
        ircSend('PASS oauth:' + String(tw.token).replace(/^oauth:/, ''));
        ircSend('NICK ' + myNick);
      } else {
        myNick = 'justinfan' + Math.floor(Math.random() * 900_000 + 100_000);
        ircSend('NICK ' + myNick);
      }
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
      /* close последует */
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
      log(
        'чат: подключились' + (tw.nick ? ' как @' + tw.nick : ' (анонимно)') + ' (#' + state.channel + ')',
      );
      ircSend('JOIN #' + state.channel);
      persist();
      return;
    }
    if (line.includes(' NOTICE ') && /Login authentication failed|Improperly formatted auth/i.test(line)) {
      log('⚠ токен Twitch отклонён — отключаем аккаунт');
      tw.token = null;
      tw.nick = null;
      saveTwitchCreds({});
      restartChat();
      return;
    }
    const sp = line.indexOf(' ');
    const prefix = line.startsWith(':') ? line.slice(1, sp < 0 ? undefined : sp) : '';
    const rest = line.slice(sp + 1);
    const nick = prefix.split('!')[0];
    if (nick && nick.toLowerCase() === myNick && rest.startsWith('JOIN #')) {
      state.joined = true;
      log('бот вошёл в #' + state.channel);
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

  // ---------- команды из чатa ----------
  function onChatMessage(user, rawText) {
    if (!state.enabled) return;
    if (/!(sr|play|songrequest)/i.test(rawText)) {
      log('чат: @' + user + ': ' + String(rawText).trim().slice(0, 70));
    }
    const cmd = P.normalizeCommand(rawText);
    if (!cmd) return;
    if (!cmd.known) {
      log('@' + user + ' написал !' + cmd.raw.slice(0, 18));
      return;
    }
    if (!cmd.rest) {
      log('→ отказ: нет ссылки');
      return;
    }

    let track = P.extractSpotifyTrack(cmd.rest);
    if (!track) {
      const urlTok = (cmd.rest.match(/https?:\/\/\S+/) || [''])[0].replace(/[),.;!?'"\]]+$/, '');
      if (urlTok && P.isSpotifyShortLink(urlTok)) {
        log('пробуем разрешить короткую ссылку…');
        void resolveShort(urlTok).then((t) => {
          if (t) enqueue(t, user);
          else log('→ отказ: короткая ссылка не открылась');
        });
        return;
      }
      log('→ отказ: нужна ссылка на трек (open.spotify.com/track/…)');
      return;
    }

    if (!P.cooldownAllows(cooldowns, state.channel + ':' + user, Date.now(), ADD_COOLDOWN_MS)) {
      log('→ кулдаун @' + user + ', пропущено');
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
    log('✓ принято от @' + by + ' (в очереди расширения: ' + pending.length + ')');
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
      /* без метаданных — не страшно */
    }
  }

  // ---------- постановка в очередь через интерфейс Spotify ----------
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
        setTimeout(poll, stepMs || 180);
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

  function setReactValue(input, value) {
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (proto && proto.set) proto.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
  }

  /* Кандидаты селекторов. Если Spotify обновит интерфейс — дополни списки здесь. */
  const MORE_BTN_SEL = [
    '[data-testid="more-button"]',
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
      if (b.closest('footer')) continue; // нижний плеер — не он
      if (b.closest('[data-testid="now-playing-widget"]')) continue;
      return b;
    }
    return null;
  }

  function findAddToQueueItem() {
    const items = document.querySelectorAll('[role="menuitem"], [role="button"], [role="menuitemcheckbox"]');
    for (const el of items) {
      const label = el.getAttribute('aria-label') || el.textContent || '';
      if (P.matchAddToQueue(label)) return el;
    }
    return null;
  }

  async function addTrackToQueueUI(job) {
    const startPath = location.pathname;

    // Путь 1: страница трека (точнее всего — одна страница, один трек)
    let more = await openTrackPage(job);

    // Путь 2: поиск (если страница трека не дала кнопку)
    if (!more) {
      log('ℹ путь «страница трека» не сработал — пробуем поиск');
      more = await openSearchPath(job);
    }
    if (!more) return false;

    click(more);
    log('шаг: открыли меню трека');
    const item = await waitFor(findAddToQueueItem, 4500);
    if (!item) {
      log('✗ пункт «Добавить в очередь» не найден в меню (язык интерфейса Spotify?)');
      pressEscape();
      pressEscape();
      return false;
    }
    click(item);
    log('шаг: нажали «Добавить в очередь»');
    await sleep(350);
    pressEscape();
    pressEscape();

    if (location.pathname !== startPath) {
      history.back();
      log('шаг: вернули прежний вид');
    }
    return true;
  }

  async function openTrackPage(job) {
    const a = document.createElement('a');
    a.href = '/track/' + job.trackId;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    const ok = await waitFor(() => location.pathname.indexOf('/track/' + job.trackId) >= 0, 5000);
    if (!ok) return null;
    await sleep(1100); // даём отрисоваться шапке
    const btn = await waitFor(findMoreButtonGlobal, 5000);
    if (btn) {
      log('шаг: открыли страницу трека, нашли кнопку «…»');
      return btn;
    }
    log('✗ страница трека открылась, но кнопка «…» не найдена');
    return null;
  }

  async function openSearchPath(job) {
    const wasSearch = location.pathname.startsWith('/search');
    if (!wasSearch) {
      const link = document.querySelector('a[href="/search"], [data-testid="search-link"]');
      if (!link) {
        log('✗ не нашли кнопку Поиск в навигации');
        return null;
      }
      click(link);
      log('шаг: открыли страницу поиска');
      await sleep(900);
    }

    const input = await waitFor(
      () =>
        document.querySelector('[data-testid="search-input"]') ||
        document.querySelector('main input[type="search"]') ||
        document.querySelector('input[placeholder]'),
      6000,
    );
    if (!input) {
      log('✗ не нашли поле поиска');
      return null;
    }
    const query = job.title ? job.title + ' ' + job.artist : job.trackId;
    setReactValue(input, query);
    try {
      input.focus && input.focus();
    } catch (e) {
      /* ignore */
    }
    log('шаг: ввели запрос «' + query.slice(0, 40) + '»');

    const btn = await waitFor(findMoreButtonGlobal, 8000);
    if (!btn) {
      log('✗ в результатах поиска не нашли кнопку «…» у трека');
      pressEscape();
      return null;
    }
    log('шаг: нашли трек в результатах поиска');
    return btn;
  }

  async function processQueue() {
    if (state.busy) return;
    const job = pending[0];
    if (!job) return;
    state.busy = true;
    persist();
    try {
      if (!job.title) await fetchMeta(job);
      log('▶ ставим в очередь Spotify: ' + (job.title || job.trackId));
      const ok = await addTrackToQueueUI(job);
      if (ok) {
        pending.shift();
        const name = job.artist ? job.artist + ' - ' + job.title : job.title || job.url;
        log('✓ добавлено в очередь Spotify: ' + name);
        void say('@' + job.by + ' Queued [' + name + ']');
      } else {
        job.attempts = (job.attempts || 0) + 1;
        if (job.attempts >= 3) {
          pending.shift();
          log('✗ сдались: ' + (job.title || job.url));
        }
        await sleep(4000);
      }
    } catch (e) {
      log('✗ ошибка: ' + (e && e.message ? e.message : String(e)));
    } finally {
      state.busy = false;
      persist();
      if (pending.length) setTimeout(() => void processQueue(), 1200);
    }
  }

  // ---------- настройки ----------
  function setChannel(ch) {
    state.channel = String(ch || '')
      .trim()
      .toLowerCase();
    chatDisconnect();
    if (state.channel) {
      stopped = true;
      state.joinRequestedAt = Date.now();
      chatConnect();
      log('канал: #' + state.channel + ' — подключаемся…');
    } else {
      log('канал отключён');
    }
    persist();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.tq_channel) setChannel(changes.tq_channel.newValue || '');
    if (changes.tq_enabled) {
      state.enabled = Boolean(changes.tq_enabled.newValue);
      log(state.enabled ? 'расширение включено' : 'расширение выключено');
    }
    if (changes.tq_twitch_client_id) {
      tw.clientId = changes.tq_twitch_client_id.newValue || '';
    }
    if ('tq_twitch_login_request' in changes) {
      beginTwitchLogin().catch((e) => log('✗ вход в Twitch: ' + (e && e.message ? e.message : e)));
    }
    if (changes.tq_twitch_token && !changes.tq_twitch_token.newValue) {
      // вышли из аккаунта из попапа (наш собственный logout уже сбросил tw)
      if (tw.token || tw.nick) log('Twitch: аккаунт отключён');
      tw.token = null;
      tw.nick = null;
      tw.refresh = null;
      restartChat();
    }
    if (changes.tq_twitch_token && changes.tq_twitch_token.newValue && changes.tq_twitch_token.newValue !== tw.token) {
      loadTwitchCreds(() => restartChat());
    }
  });

  // ---------- старт ----------
  loadTwitchCreds(() => {
    chrome.storage.local.get(['tq_channel', 'tq_enabled', 'tq_events'], (r) => {
      state.enabled = r.tq_enabled !== false;
      if (Array.isArray(r.tq_events)) state.events = r.tq_events;
      log('расширение запущено на ' + location.host);
      if (r.tq_channel) setChannel(r.tq_channel);
      else persist();
    });
  });
})();
