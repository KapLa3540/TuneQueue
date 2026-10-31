/* TuneQueue content script:
 * 1) слушает чат Twitch напрямую (WebSocket, анонимно) — открытый чат не нужен;
 * 2) по !sr/!play <ссылка> сам находит трек в веб-плеере Spotify
 *    и нажимает его собственную кнопку «Добавить в очередь».
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
  const pending = []; // {trackId,url,title,artist,by}

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
      myNick = 'justinfan' + Math.floor(Math.random() * 900_000 + 100_000);
      sock.send('NICK ' + myNick + '\r\n');
      sock.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
    });

    sock.addEventListener('message', (ev) => {
      for (const line of String(ev.data).split('\r\n')) {
        if (line) handleLine(line, sock);
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

  function ircSend(sock, line) {
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(line + '\r\n');
  }

  function handleLine(line, sock) {
    if (line.startsWith('PING')) {
      ircSend(sock, line.replace('PING', 'PONG'));
      return;
    }
    if (/^:tmi\.twitch\.tv\s+001\s/.test(line)) {
      ready = true;
      backoff = 1000;
      state.connected = true;
      state.joinRequestedAt = Date.now();
      log('чат: подключились к Twitch (#' + state.channel + ')');
      ircSend(sock, 'JOIN #' + state.channel);
      persist();
      return;
    }
    // собственный JOIN подтверждён?
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

  // ---------- команды из чата ----------
  function onChatMessage(user, rawText) {
    if (!state.enabled) return;
    if (state.events.length < MAX_EVENTS && /!(sr|play|songrequest)/i.test(rawText)) {
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
        resolveShort(urlTok).then((t) => {
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
    pending.push({ trackId: track.trackId, url: track.url, title: '', artist: '', by: by });
    log('✓ принято от @' + by + ' (в очереди расширения: ' + pending.length + ')');
    void fetchMeta(pending[pending.length - 1]);
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

  // ---------- постановка в очередь через UI Spotify ----------
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
    el.scrollIntoView && el.scrollIntoView({ block: 'nearest' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();
    return true;
  }

  function setReactValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
  }

  function findMoreButton(row) {
    const byLabel = row.querySelector(
      'button[aria-label*="options" i], button[aria-label*="Ещё" i], button[aria-label*="opzioni" i], button[aria-label*="option" i]',
    );
    if (byLabel) return byLabel;
    // фолбэк: в футере строки кнопки — последняя обычно «ещё»
    const buttons = row.querySelectorAll('button');
    return buttons.length ? buttons[buttons.length - 1] : null;
  }

  function findAddToQueueItem() {
    const items = document.querySelectorAll('[role="menuitem"], [role="button"]');
    for (const el of items) {
      const label = el.getAttribute('aria-label') || el.textContent || '';
      if (P.matchAddToQueue(label)) return el;
    }
    return null;
  }

  function findFirstTrackRow() {
    const list =
      document.querySelector('[data-testid="track-list"]') ||
      document.querySelector('main [role="list"]') ||
      document.querySelector('main');
    if (!list) return null;
    const rows = list.querySelectorAll('[data-testid="entityRow"], [role="row"]');
    for (const row of rows) {
      // в строке-результате поиска должна быть кнопка «ещё» — это трек
      if (findMoreButton(row)) return row;
    }
    return null;
  }

  async function addTrackToQueueUI(job) {
    const wasSearch = location.pathname.startsWith('/search');
    if (!wasSearch) {
      const link = document.querySelector('a[href="/search"], [data-testid="search-link"]');
      if (!link) {
        log('✗ не нашли кнопку Поиск в навигации');
        return false;
      }
      click(link);
      log('шаг: открыли страницу поиска');
      await sleep(700);
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
      return false;
    }
    const query = job.title ? job.title + ' ' + job.artist : job.trackId;
    setReactValue(input, query);
    input.focus && input.focus();
    log('шаг: ввели запрос «' + query.slice(0, 40) + '»');

    const row = await waitFor(findFirstTrackRow, 8000);
    if (!row) {
      log('✗ не появились результаты поиска');
      pressEscape();
      return false;
    }

    const more = findMoreButton(row);
    if (!more) {
      log('✗ не нашли кнопку «ещё» у трека');
      pressEscape();
      return false;
    }
    click(more);
    log('шаг: открыли меню трека');

    const item = await waitFor(findAddToQueueItem, 4000);
    if (!item) {
      log('✗ пункт «Добавить в очередь» не найден (язык интерфейса Spotify?)');
      pressEscape();
      pressEscape();
      return false;
    }
    click(item);
    log('шаг: нажали «Добавить в очередь»');
    await sleep(300);
    pressEscape();
    pressEscape();

    if (!wasSearch) {
      history.back();
      log('шаг: вернули прежний вид');
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
      log('▶ ставим в очередь Spotify: ' + (job.title || job.trackId));
      const ok = await addTrackToQueueUI(job);
      if (ok) {
        pending.shift();
        log('✓ добавлено в очередь Spotify: ' + (job.title || job.url));
      } else {
        // пробуем ещё раз при следующем тике, максимум 3 попытки
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
      if (pending.length) setTimeout(processQueue, 1200);
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
  });

  chrome.storage.local.get(['tq_channel', 'tq_enabled', 'tq_events'], (r) => {
    state.enabled = r.tq_enabled !== false;
    if (Array.isArray(r.tq_events)) state.events = r.tq_events;
    if (r.tq_channel) setChannel(r.tq_channel);
    else persist();
    log('расширение запущено на ' + location.host);
  });
})();
