import type { AppState, Action, QueueItem, ItemStatus } from '../shared/types.js';
import type { TqApi } from '../preload.js';

declare global {
  interface Window {
    tq: TqApi;
  }
}

const root = document.getElementById('root')!;
let state: AppState | null = null;
let deviceOpen = false;
let deviceCode = '';
let deviceUri = '';

const STATUS_LABEL: Record<ItemStatus, string> = {
  queued: 'в очереди',
  playing: 'играет',
  done: 'сыграно',
  skipped: 'скип',
  failed: 'ошибка',
};

async function act(action: Action): Promise<void> {
  const res = await window.tq.action(action);
  if (!res.ok && res.error) {
    alert(res.error);
  }
  state = await window.tq.getState();
  render();
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function chip(cls: string, text: string, title?: string): string {
  return `<span class="chip ${cls}" ${title ? `title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

function render(): void {
  if (!state) return;
  const s = state;

  const chatChip = s.chat.joined
    ? chip('ok', s.chat.canSend ? `чат: ${s.chat.channel} ✓` : `слушает #${s.chat.channel}`)
    : s.chat.connected
      ? chip('warn', 'заходим в чат…')
      : s.chat.channel
        ? chip('warn', 'чат: нет подключения')
        : chip('warn', 'канал не задан');

  const p = s.player;
  const playerChip = !p.installed
    ? chip('bad', 'Spotify не найден', 'Установи Spotify или проверь установку')
    : p.found
      ? p.playback === 'playing'
        ? chip('ok', 'плеер: играет')
        : p.playback === 'paused'
          ? chip('warn', 'плеер: пауза')
          : chip('warn', 'плеер: без активности')
      : chip('warn', 'плеер: не запущен');

  const queueChip =
    s.autoplay
      ? chip('ok', 'очередь: автоплей')
      : chip('bad', 'очередь: на паузе');

  const mode = s.player.mode;
  const statusLine =
    mode === 'injecting'
      ? 'ставим трек в плеер…'
      : mode === 'serving'
        ? 'раздаём очередь'
        : null;

  const items = s.queue;
  const active = items.filter((i) => i.status === 'queued' || i.status === 'playing');
  const finished = items.filter((i) => i.status !== 'queued' && i.status !== 'playing').slice(-15).reverse();

  root.innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="logo">Tune<span>Queue</span></div>
        <div class="chips">${chatChip}${playerChip}${queueChip}</div>
      </div>

      ${s.notice ? `<div class="banner notice" id="notice">${esc(s.notice)}</div>` : ''}
      ${s.chat.error ? `<div class="banner error" id="chat-error">${esc(s.chat.error)}</div>` : ''}

      <div class="grid">
        <section class="card">
          <h2>Плеер сейчас</h2>
          ${
            p.found && p.title
              ? `<div class="now">
                  <div class="now-thumb">${p.playback === 'playing' ? '♪' : '⏸'}</div>
                  <div>
                    <div class="now-title">${esc(p.title)}</div>
                    <div class="now-artist">${esc(p.artist)}</div>
                    <div class="now-meta">${p.playback === 'playing' ? '▶' : '⏸'} ${fmtTime(p.posMs)}${
                      p.durMs ? ` / ${fmtTime(p.durMs)}` : ''
                    }${statusLine ? ` · ${statusLine}` : ''}</div>
                  </div>
                </div>`
              : `<div class="hint">${
                  !p.installed
                    ? 'Spotify не обнаружен. Установи официальный клиент Spotify — приложение управляет им напрямую.'
                    : 'Плеер Spotify не запущен или сейчас не играет. Первый запрос автоматически откроет Spotify.'
                }</div>`
          }
          <label class="switch">
            <input type="checkbox" id="autoplay" ${s.autoplay ? 'checked' : ''} />
            Автоплей очереди (ставить запрошенные треки)
          </label>
          <label class="switch">
            <input type="checkbox" id="notify" ${s.notify ? 'checked' : ''} />
            Уведомления о новых запросах
          </label>
        </section>

        <section class="card">
          <h2>Канал и чат</h2>
          ${
            s.channel
              ? `<div class="row">
                  <div class="hint" style="flex:1">Twitch: <b>#${esc(s.channel)}</b>${
                    s.auth.nick ? ` · ответы от <b>@${esc(s.auth.nick)}</b>` : ' · чтение чата анонимное'
                  }</div>
                  <button class="ghost" id="disconnect">отключить</button>
                </div>`
              : `<div class="row">
                  <input type="text" id="channel-input" placeholder="nick_twitch_канала" spellcheck="false" />
                  <button id="connect">Подключить</button>
                </div>
                <div class="hint" style="margin-top:8px">Приложение само подключится к чату — открывать чат не нужно.</div>`
          }

          <h3>Ответы в чате</h3>
          ${
            s.auth.hasToken
              ? `<div class="row">
                  <div class="hint" style="flex:1">Вошли как <b>@${esc(s.auth.nick ?? '')}</b> — бот отвечает от твоего имени.</div>
                  <button class="ghost" id="logout">выйти</button>
                </div>`
              : `<div class="row">
                  <input type="text" id="client-id" placeholder="Twitch Client ID (опционально)" value="${esc(
                    s.auth.clientId,
                  )}" spellcheck="false" />
                  <button id="save-cid" class="ghost">сохранить</button>
                </div>
                <div class="row" style="margin-top:9px">
                  <button id="login" class="green" style="flex:1" ${s.auth.clientId ? '' : 'disabled'}>
                    Войти через Twitch (чтобы отвечать в чате)
                  </button>
                </div>
                <div class="hint" style="margin-top:8px">
                  Без входа всё работает: команды выполняются молча. Client ID — бесплатное приложение на
                  <a href="https://dev.twitch.tv/console/apps" target="_blank" style="color:var(--green)">dev.twitch.tv</a>.
                </div>`
          }

          ${
            deviceOpen || s.auth.device
              ? `<div class="device">
                  <div class="hint">Введи код на странице Twitch:</div>
                  <div class="code" id="device-code">${esc(s.auth.device?.code ?? deviceCode)}</div>
                  <div class="hint">
                    <a href="${esc(s.auth.device?.uri ?? deviceUri)}" target="_blank" id="device-link">${
                      esc(s.auth.device?.uri ?? deviceUri)
                    }</a>
                  </div>
                  <div class="hint" style="margin-top:6px">ожидаем подтверждения…</div>
                </div>`
              : ''
          }

          <h3>Команды в чате</h3>
          <ul class="cmds">
            <li><code>!sr &lt;ссылка&gt;</code> — добавить трек в очередь</li>
            <li><code>!play &lt;ссылка&gt;</code> — то же самое</li>
          </ul>
          <div class="hint" style="margin-top:6px">Пропуск — в самом плеере Spotify (кнопка Next). Скипаете вы, не бот.</div>
        </section>

        <section class="card wide">
          <div class="rowhead">
            <h2>Очередь${active.length ? ` · ${active.length}` : ''}</h2>
            <div class="actions">
              <button class="ghost" id="clear-done">очистить завершённые</button>
              <button class="ghost" id="clear-queued">очистить очередь</button>
            </div>
          </div>
          ${
            active.length === 0
              ? `<div class="empty">Пусто. Зрители пишут <code>!sr https://open.spotify.com/track/…</code></div>`
              : active.map((i, idx) => queueRow(i, idx + 1)).join('')
          }
          ${
            finished.length
              ? `<h3>История</h3>${finished.map((i, idx) => queueRow(i, idx + 1, true)).join('')}`
              : ''
          }
        </section>
      </div>

      <div class="footer">TuneQueue · без Spotify API · без Premium · без подписок · open source (MIT)</div>
    </div>
  `;
  bind();
}

function queueRow(i: QueueItem, num: number, finishedRow = false): string {
  const playing = i.status === 'playing';
  const thumb = i.thumb
    ? `<img class="qthumb" src="${esc(i.thumb)}" alt="" />`
    : `<div class="qthumb">♪</div>`;
  const title = i.title === i.url ? i.url.replace('https://', '') : i.title;
  const sub = [
    i.artist,
    i.by ? `от ${i.by}` : '',
    i.status === 'queued' ? new Date(i.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `
    <div class="qrow ${playing ? 'playing' : ''} ${finishedRow ? 'finished' : ''}">
      <div class="qnum">${playing ? '▶' : num}</div>
      ${thumb}
      <div class="qmeta">
        <div class="qname">${esc(title)}</div>
        ${sub ? `<div class="qsub">${esc(sub)}</div>` : ''}
        ${i.error ? `<div class="qerr">${esc(i.error)}</div>` : ''}
      </div>
      <span class="status s-${i.status}">${STATUS_LABEL[i.status]}</span>
      ${(i.status === 'queued' || i.status === 'failed') && !playing
        ? `<button class="ghost qbtn" data-remove="${i.id}" title="Убрать">✕</button>`
        : ''}
    </div>`;
}

function bind(): void {
  const $ = (id: string) => document.getElementById(id);

  $('connect')?.addEventListener('click', () => {
    const input = $('channel-input') as HTMLInputElement | null;
    if (input?.value) void act({ type: 'setChannel', channel: input.value });
  });
  ($('channel-input') as HTMLInputElement | null)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('connect')?.click();
  });

  $('disconnect')?.addEventListener('click', () => void act({ type: 'disconnect' }));

  $('autoplay')?.addEventListener('change', (e) => {
    void act({ type: 'setAutoplay', on: (e.target as HTMLInputElement).checked });
  });
  $('notify')?.addEventListener('change', (e) => {
    void act({ type: 'setNotify', on: (e.target as HTMLInputElement).checked });
  });

  $('save-cid')?.addEventListener('click', () => {
    const v = (($('client-id') as HTMLInputElement | null)?.value ?? '').trim();
    if (v) void act({ type: 'setClientId', clientId: v });
  });

  $('login')?.addEventListener('click', async () => {
    const res = await window.tq.action({ type: 'twitchLogin' });
    if (!res.ok && res.error) alert(res.error);
    else deviceOpen = true;
    state = await window.tq.getState();
    render();
  });

  $('logout')?.addEventListener('click', () => void act({ type: 'twitchLogout' }));

  $('notice')?.addEventListener('click', () => void act({ type: 'dismissNotice' }));
  $('chat-error')?.addEventListener('click', () => void act({ type: 'dismissNotice' }));

  $('clear-done')?.addEventListener('click', () => void act({ type: 'clearFinished' }));
  $('clear-queued')?.addEventListener('click', () => void act({ type: 'clearQueue' }));

  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-remove]')) {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.remove);
      if (id) void act({ type: 'removeItem', id });
    });
  }
}

// ---------- старт ----------
let dirtyWhileFocused = false;

function hasFocusedInput(): boolean {
  const ae = document.activeElement;
  return ae?.tagName === 'INPUT';
}

async function main(): Promise<void> {
  state = await window.tq.getState();
  render();
  window.tq.onState((s) => {
    if (!s.auth.device) deviceOpen = false;
    state = s;
    // не перерисовываем, пока человек печатает в поле — иначе фокус сбрасывается
    if (hasFocusedInput()) {
      dirtyWhileFocused = true;
      return;
    }
    render();
  });
  document.addEventListener('focusout', () => {
    if (dirtyWhileFocused && !hasFocusedInput()) {
      dirtyWhileFocused = false;
      render();
    }
  });
}

void main();
