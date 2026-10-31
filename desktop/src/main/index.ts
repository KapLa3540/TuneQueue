import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, shell } from 'electron';
import path from 'path';
import { Store } from './store.js';
import { TwitchChat } from './irc.js';
import { TwitchAuth, refreshStoredToken } from './twitchAuth.js';
import { QueueService, parseSpotifyTrack } from './queue.js';
import { fetchTrackMeta } from './oembed.js';
import { isSpotifyShortLink, resolveShortLink } from './shortlink.js';
import { createPlayer } from './player/windows.js';
import { ServingController } from './serving.js';
import type { AppState, Action, ActionResult, ChatState, PlayerState, AuthState } from '../shared/types.js';
import { IPC } from '../shared/types.js';

const isDev = !app.isPackaged;

// ---------- лог событий для UI (последние 40) ----------
const events: { t: number; text: string }[] = [];
function logEvent(text: string): void {
  events.push({ t: Date.now(), text });
  if (events.length > 40) events.shift();
  bump();
}

// ---------- состояние ----------
const store = new Store();
const queue = new QueueService();
const player = createPlayer();
let version = 0;
let notice: string | null = null;
let chatState: ChatState = {
  connected: false,
  joined: false,
  channel: store.cfg.channel,
  canSend: false,
  loggedIn: Boolean(store.cfg.twitchNick),
  nick: store.cfg.twitchNick,
  error: null,
};

function setNotice(msg: string | null): void {
  notice = msg;
  bump();
}

const serving = new ServingController({
  player,
  queue,
  now: Date.now,
  autoplay: () => store.cfg.autoplay,
  setAutoplay: (on) => store.update({ autoplay: on }),
  onNotice: setNotice,
});

const auth = new TwitchAuth(store, {
  onUpdate: () => bump(),
  onToken: (token, nick) => {
    chatState = { ...chatState, loggedIn: true, nick };
    restartChat();
    bump();
  },
  onLogout: () => {
    chatState = { ...chatState, loggedIn: false, nick: null };
    restartChat();
    bump();
  },
});

// ---------- чат ----------
const chat = new TwitchChat(
  () => ({
    channel: store.cfg.channel.toLowerCase(),
    token: store.cfg.twitchToken,
    nick: store.cfg.twitchNick,
  }),
  {
    onConnected: (c) => {
      chatState = { ...chatState, connected: c, channel: store.cfg.channel };
      if (!c) chatState = { ...chatState, joined: false };
      logEvent(c ? `чат: подключились к Twitch (#${store.cfg.channel})` : 'чат: отключились');
      bump();
    },
    onJoined: (j) => {
      chatState = { ...chatState, joined: j };
      logEvent(j ? `бот вошёл в #${store.cfg.channel}` : `бот вышел из #${store.cfg.channel}`);
      bump();
    },
    onAuthError: () => {
      store.update({ twitchToken: null, twitchRefresh: null, twitchNick: null });
      chatState = { ...chatState, loggedIn: false, nick: null, error: 'Токен Twitch истёк — войди заново' };
      logEvent('⚠ токен Twitch истёк');
      restartChat();
      bump();
    },
    onMessage: (user, text, tags) => void handleChat(user, text, tags),
  },
);

function restartChat(): void {
  chat.stop();
  if (store.cfg.channel) chat.start();
}

// ---------- команды в чате ----------
const KNOWN_CMDS = new Set(['sr', 'play', 'songrequest']);

async function handleChat(user: string, text: string, _tags: Record<string, string>): Promise<void> {
  const t = text.trim();
  if (!t.startsWith('!')) return;

  const m = t.match(/^!(\S+)(?:\s+(\S+))?/);
  if (!m) return;
  const rawName = m[1];
  const name = rawName.toLowerCase().replace(/[^a-z]/g, '');
  const arg = (m[2] ?? '').trim();

  if (!KNOWN_CMDS.has(name)) {
    // отмечаем любые !-команды, чтобы было видно, что чат до нас доходит
    logEvent(`@${user} написал ${rawName.slice(0, 20)}`);
    return;
  }

  logEvent(`@${user}: !${name} ${arg.slice(0, 70)}`.trim());

  if (!arg) {
    chat.say(`${user}, используй: !sr <ссылка на трек Spotify>`);
    logEvent('→ отказ: не указана ссылка');
    return;
  }

  let parsed = parseSpotifyTrack(arg);
  if (!parsed && isSpotifyShortLink(arg)) {
    logEvent('пробуем разрешить короткую ссылку spotify.link…');
    parsed = await resolveShortLink(arg);
    if (parsed) logEvent(`короткая ссылка → track/${parsed.trackId}`);
    else logEvent('→ отказ: короткая ссылка не открылась');
  }

  if (!parsed) {
    chat.say(`${user}, нужна ссылка на трек: open.spotify.com/track/...`);
    if (store.cfg.notify && Notification.isSupported()) {
      new Notification({ title: 'TuneQueue', body: `❌ ${user}: нужна ссылка на трек Spotify` }).show();
    }
    logEvent(`→ отказ: «${arg.slice(0, 50)}» — не ссылка на трек`);
    return;
  }

  const res = queue.add(parsed, user, store.cfg.channel);
  if (!res.ok || !res.item) {
    if (res.reason === 'full') chat.say(`${user}, очередь полна`);
    logEvent(res.reason === 'cooldown' ? '→ кулдаун, пропущено' : '→ очередь полна');
    return; // cooldown — молчим в чате, но в лог пишем
  }

  const item = res.item;
  // обогащение названием (публичный oEmbed, без ключей)
  void fetchTrackMeta(item.url).then((meta) => {
    if (meta) {
      queue.enrich(item.id, meta.title, meta.artist, meta.thumb);
      bump();
    }
  });

  const n = queue.queuedCount();
  chat.say(`✅ ${user}: добавлено в очередь (всего ${n})`);
  if (store.cfg.notify && Notification.isSupported()) {
    new Notification({ title: 'TuneQueue', body: `🔔 ${user} запросил трек` }).show();
  }
  logEvent(`✓ принято: ${user} → track/${item.trackId} (в очереди ${n})`);
  bump();
}

// ---------- состояние для UI ----------
function playerState(): PlayerState {
  const s = serving.lastState;
  const found = Boolean(s?.found);
  return {
    installed: player.installed(),
    found,
    title: s?.title ?? '',
    artist: s?.artist ?? '',
    playback: s?.playback ?? 'none',
    posMs: s?.posMs ?? 0,
    durMs: s?.durMs ?? 0,
    mode: store.cfg.autoplay ? serving.mode : 'off',
    servingId: serving.servingId,
    sessions: s?.sessions ?? [],
  };
}

function authState(): AuthState {
  const d = auth.getDevice();
  return {
    hasToken: Boolean(store.cfg.twitchToken),
    nick: store.cfg.twitchNick,
    clientId: store.cfg.twitchClientId,
    device: d
      ? { code: d.user_code, uri: d.verification_uri, expiresAt: Date.now() + d.expires_in * 1000, status: 'waiting', error: null }
      : null,
  };
}

function snapshot(): AppState {
  return {
    version,
    channel: store.cfg.channel,
    autoplay: store.cfg.autoplay,
    notify: store.cfg.notify,
    chat: chatState,
    player: playerState(),
    auth: authState(),
    queue: queue.all(),
    notice,
    events: [...events],
  };
}

function bump(): void {
  // пушим только если что-то реально изменилось (кроме версии)
  const s = snapshot();
  const { version: _v, ...rest } = s;
  const json = JSON.stringify(rest);
  if (json === lastJson) return;
  lastJson = json;
  version += 1;
  const state = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.statePush, state);
  }
}
let lastJson = '';

// ---------- действия UI ----------
async function runAction(action: Action): Promise<ActionResult> {
  switch (action.type) {
    case 'setChannel': {
      const ch = action.channel.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,25}$/.test(ch)) return { ok: false, error: 'Некорректный ник Twitch-канала' };
      store.update({ channel: ch });
      chatState = { ...chatState, channel: ch, joined: false, connected: false };
      restartChat();
      bump();
      return { ok: true };
    }
    case 'disconnect':
      store.update({ channel: '' });
      restartChat();
      bump();
      return { ok: true };
    case 'setAutoplay':
      store.update({ autoplay: action.on });
      serving.resetFails();
      bump();
      return { ok: true };
    case 'setNotify':
      store.update({ notify: action.on });
      bump();
      return { ok: true };
    case 'removeItem':
      return { ok: queue.remove(action.id) };
    case 'clearFinished':
      queue.clearFinished();
      bump();
      return { ok: true };
    case 'clearQueue':
      queue.clearQueued();
      bump();
      return { ok: true };
    case 'setClientId':
      store.update({ twitchClientId: action.clientId.trim() });
      bump();
      return { ok: true };
    case 'twitchLogin': {
      try {
        const info = await auth.begin();
        void shell.openExternal(info.verification_uri);
        bump();
        return { ok: true, data: { code: info.user_code, uri: info.verification_uri } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    case 'twitchLogout':
      auth.logout();
      return { ok: true };
    case 'dismissNotice':
      notice = null;
      bump();
      return { ok: true };
    default:
      return { ok: false, error: 'Неизвестное действие' };
  }
}

// ---------- окно ----------
let win: BrowserWindow | null = null;
let tray: Tray | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0e0e12',
    title: 'TuneQueue',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // внешние ссылки (dev.twitch.tv и т.п.) открываем в системном браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.on('close', (e) => {
    // закрытие = свернуть в трей, приложение продолжает слушать чат
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

let quitting = false;

function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const fromPath = nativeImage.createFromPath(iconPath);
  const image = fromPath.isEmpty() ? nativeImage.createEmpty() : fromPath;
  tray = new Tray(image);
  tray.setToolTip('TuneQueue');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Показать TuneQueue', click: () => win?.show() },
      { type: 'separator' },
      { label: 'Выход', click: () => {
          quitting = true;
          app.quit();
        } },
    ]),
  );
  tray.on('click', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

// ---------- bootstrap ----------
ipcMain.handle(IPC.getState, () => snapshot());
ipcMain.handle(IPC.action, (_e, action: Action) => runAction(action));

app.whenReady().then(async () => {
  console.log('[tq] TuneQueue запускается…');
  createWindow();
  createTray();

  await refreshStoredToken(store);
  await auth.validateStored();
  if (store.cfg.channel) chat.start();

  // главный цикл: раздача очереди + синхронизация UI
  setInterval(() => {
    void serving
      .tick()
      .catch((err) => console.error('[serving]', err))
      .then(() => bump());
  }, 2000);
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  // остаёмся в трее (кроме macOS — там штатное поведение)
  if (process.platform === 'darwin') return;
});
