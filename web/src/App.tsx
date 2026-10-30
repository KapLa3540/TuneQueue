import { useCallback, useEffect, useMemo, useState } from 'react';

interface Playback {
  is_playing: boolean;
  device: { id: string | null; name: string; volume_percent: number | null } | null;
  item: {
    id: string;
    uri: string;
    name: string;
    duration_ms: number;
    artists: Array<{ name: string }>;
    album?: { images?: Array<{ url: string }> };
  } | null;
  progress_ms: number | null;
}

interface Status {
  channel: string;
  bot_joined: boolean;
  bot_state: 'joined' | 'joining' | 'failed' | 'none';
  bot_can_send: boolean;
  spotify: { connected: boolean; display_name: string | null };
  counts: Record<string, number>;
  playback: Playback | null;
  playback_error: string | null;
}

type QueueStatus = 'pending' | 'pushed' | 'playing' | 'played' | 'skipped' | 'failed';

interface QueueItem {
  id: number;
  uri: string;
  name: string;
  artists: string;
  album_art: string | null;
  duration_ms: number;
  requested_by: string;
  status: QueueStatus;
  error: string | null;
  created_at: number;
  active: boolean;
}

const STORAGE_KEY = 'tq_setup_token';

function readUrlParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function cleanUrl(): void {
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', url.toString());
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

const STATUS_LABEL: Record<QueueStatus, string> = {
  pending: 'в очереди',
  pushed: 'в Spotify',
  playing: 'играет',
  played: 'сыграно',
  skipped: 'пропущено',
  failed: 'ошибка',
};

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function App() {
  const [token, setToken] = useState<string | null>(() => {
    const fromUrl = readUrlParam('setup');
    if (fromUrl) {
      localStorage.setItem(STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    return localStorage.getItem(STORAGE_KEY);
  });
  const [urlError, setUrlError] = useState<string | null>(readUrlParam('setup_error'));
  const [justLinked, setJustLinked] = useState(readUrlParam('linked') === '1');
  const [status, setStatus] = useState<Status | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [channelInput, setChannelInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (readUrlParam('setup') || readUrlParam('setup_error') || readUrlParam('linked')) cleanUrl();
    if (justLinked) {
      void api(`/api/channels/${token}/spotify/refresh-profile`, { method: 'POST' }).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [st, q] = await Promise.all([
        api<Status>(`/api/channels/${token}`),
        api<{ items: QueueItem[] }>(`/api/channels/${token}/queue`),
      ]);
      setStatus(st);
      setItems(q.items);
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.message === 'Не найдено') {
        localStorage.removeItem(STORAGE_KEY);
        setToken(null);
        setError('Ссылка настройки недействительна — подключи канал заново.');
      }
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [token, refresh]);

  async function createChannel(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ setup_token: string }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({ channel: channelInput }),
      });
      localStorage.setItem(STORAGE_KEY, res.setup_token);
      setToken(res.setup_token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function attachExisting(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const match = tokenInput.match(/setup=([a-f0-9]{48})/) || tokenInput.match(/^([a-f0-9]{48})$/);
    if (!match) {
      setError('Вставь ссылку настройки или сам токен.');
      return;
    }
    localStorage.setItem(STORAGE_KEY, match[1]);
    setToken(match[1]);
  }

  async function control(action: string): Promise<void> {
    if (!token) return;
    try {
      await api(`/api/channels/${token}/control/${action}`, { method: 'POST' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeItem(id: number): Promise<void> {
    if (!token) return;
    await api(`/api/channels/${token}/items/${id}`, { method: 'DELETE' }).catch(() => {});
    await refresh();
  }

  async function retryItem(id: number): Promise<void> {
    if (!token) return;
    await api(`/api/channels/${token}/items/${id}/retry`, { method: 'POST' }).catch(() => {});
    await refresh();
  }

  async function clearQueue(): Promise<void> {
    if (!token) return;
    await api(`/api/channels/${token}/clear`, { method: 'POST' }).catch(() => {});
    await refresh();
  }

  async function disconnect(): Promise<void> {
    if (!token) return;
    if (!window.confirm('Отключить канал? Все данные канала будут удалены.')) return;
    await api(`/api/channels/${token}`, { method: 'DELETE' }).catch(() => {});
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setStatus(null);
    setItems([]);
  }

  const setupLink = useMemo(
    () => (token ? `${window.location.origin}/?setup=${token}` : ''),
    [token],
  );

  if (!token) {
    return (
      <div className="shell">
        <header className="hero">
          <h1>
            Tune<span>Queue</span>
          </h1>
          <p className="tagline">Song requests для Twitch на Spotify. Без подписок и хуйни.</p>
        </header>

        <main className="landing">
          <section className="card">
            <h2>Подключить канал</h2>
            <form onSubmit={createChannel}>
              <input
                value={channelInput}
                onChange={(e) => setChannelInput(e.target.value)}
                placeholder="nick_twitch_канала"
                autoCapitalize="none"
                spellCheck={false}
              />
              <button type="submit" disabled={busy || channelInput.trim().length < 3}>
                {busy ? '…' : 'Подключить'}
              </button>
            </form>
            <p className="hint">
              После подключения свяжи Spotify — и бот зайдёт в чат твоего канала. Всё бесплатно.
            </p>
          </section>

          <section className="card">
            <h2>Уже подключался?</h2>
            <form onSubmit={attachExisting}>
              <input
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ссылка настройки или токен"
                spellCheck={false}
              />
              <button type="submit">Открыть</button>
            </form>
          </section>

          {urlError && <div className="banner error">Ошибка подключения Spotify: {urlError}</div>}
          {error && <div className="banner error">{error}</div>}
        </main>

        <footer className="footer">
          open source · MIT · сам хостинг или наш инстанс · требует Spotify Premium для управления
          плеером
        </footer>
      </div>
    );
  }

  const playback = status?.playback ?? null;
  const device = playback?.device ?? null;
  const current = playback?.item ?? null;
  const artists = current?.artists?.map((a) => a.name).join(', ') ?? '';

  const active = items.filter((i) => i.active && i.status !== 'playing');
  const playingItem = items.find((i) => i.status === 'playing');
  const history = items.filter((i) => !i.active || i.status === 'playing');

  return (
    <div className="shell">
      <header className="topbar">
        <h1>
          Tune<span>Queue</span>
        </h1>
        <div className="chips">
          <span
            className={`chip ${
              status?.bot_state === 'joined' ? 'ok' : status?.bot_state === 'failed' ? 'bad' : 'warn'
            }`}
            title={
              status?.bot_state === 'failed'
                ? 'Twitch не подтвердил вход — обычно это значит, что такого канала не существует'
                : undefined
            }
          >
            {status?.bot_state === 'joined'
              ? 'бот в чате'
              : status?.bot_state === 'joining'
                ? 'бот заходит…'
                : status?.bot_state === 'failed'
                  ? 'канал не найден на Twitch'
                  : 'бот не в чате'}
          </span>
          <span className={`chip ${status?.spotify.connected ? 'ok' : 'warn'}`}>
            {status?.spotify.connected
              ? `spotify: ${status.spotify.display_name ?? 'ok'}`
              : 'spotify не подключён'}
          </span>
          <span className={`chip ${device ? 'ok' : 'muted'}`}>
            {device ? `плеер: ${device.name}` : 'плеер офлайн'}
          </span>
        </div>
        <button className="ghost" onClick={() => void disconnect()}>
          отключить
        </button>
      </header>

      {urlError && <div className="banner error">Spotify: {urlError}</div>}
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {status && !status.bot_can_send && status.bot_joined && (
        <div className="banner info">
          Бот слушает чат, но молчит: на сервере не задан TWITCH_BOT_OAUTH. Команды работают,
          ответы в чат придут после настройки токена.
        </div>
      )}

      <main className="grid">
        {/* --- плеер --- */}
        <section className="card player">
          <h2>Плеер</h2>
          {current ? (
            <div className="now">
              {current.album?.images?.[0]?.url && (
                <img src={current.album.images[0].url} alt="" />
              )}
              <div>
                <div className="now-title">{current.name}</div>
                <div className="now-artist">{artists}</div>
                <div className="now-meta">
                  {playback?.is_playing ? '▶ играет' : '⏸ пауза'}
                  {playback?.progress_ms != null &&
                    ` · ${fmtDuration(playback.progress_ms)} / ${fmtDuration(current.duration_ms)}`}
                </div>
              </div>
            </div>
          ) : (
            <p className="hint">
              {status?.playback_error
                ? `Spotify: ${status.playback_error}`
                : 'Ничего не играет. Открой Spotify на устройстве и нажми Play — бот начнёт закидывать треки из очереди.'}
            </p>
          )}
          <div className="controls">
            <button onClick={() => void control('previous')} title="Предыдущий">⏮</button>
            <button
              onClick={() => void control(playback?.is_playing ? 'pause' : 'play')}
              title="Play/Pause"
            >
              {playback?.is_playing ? '⏸' : '▶'}
            </button>
            <button onClick={() => void control('next')} title="Следующий">⏭</button>
            <button className="accent" onClick={() => void control('next')}>
              пропустить
            </button>
          </div>
        </section>

        {/* --- команда канала --- */}
        <section className="card">
          <h2>Канал: #{status?.channel}</h2>
          <label className="field">Ссылка настройки (не терять):</label>
          <div className="copyrow">
            <input readOnly value={setupLink} onFocus={(e) => e.currentTarget.select()} />
            <button
              onClick={() => {
                void navigator.clipboard.writeText(setupLink).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'скопировано' : 'копировать'}
            </button>
          </div>
          {!status?.spotify.connected && (
            <a className="button big" href={`/api/spotify/auth?token=${token}`}>
              🔗 Подключить Spotify
            </a>
          )}
          <h3>Команды в чате</h3>
          <ul className="cmds">
            <li><code>!play название</code> — запрос трека</li>
            <li><code>!queue</code> — показать очередь</li>
            <li><code>!np</code> — что играет</li>
            <li><code>!skip</code> — пропустить (моды)</li>
          </ul>
        </section>

        {/* --- очередь --- */}
        <section className="card wide">
          <div className="rowhead">
            <h2>Очередь</h2>
            <div className="actions">
              <button className="ghost" onClick={() => void refresh()}>обновить</button>
              <button className="ghost" onClick={() => void clearQueue()}>очистить</button>
            </div>
          </div>

          {playingItem && (
            <QueueRow item={playingItem} onRemove={removeItem} onRetry={retryItem} highlight />
          )}

          {active.length === 0 && !playingItem && (
            <p className="hint">Пусто. Зрители пишут <code>!play трек</code> в чате.</p>
          )}
          {active.map((i) => (
            <QueueRow key={i.id} item={i} onRemove={removeItem} onRetry={retryItem} />
          ))}

          {history.length > 0 && (
            <>
              <h3 className="history-head">История</h3>
              {history.slice(0, 20).map((i) => (
                <QueueRow key={i.id} item={i} onRemove={removeItem} onRetry={retryItem} muted />
              ))}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function QueueRow({
  item,
  onRemove,
  onRetry,
  muted,
  highlight,
}: {
  item: QueueItem;
  onRemove: (id: number) => void;
  onRetry: (id: number) => void;
  muted?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={`qrow ${muted ? 'muted' : ''} ${highlight ? 'playing' : ''}`}>
      {item.album_art ? (
        <img className="thumb" src={item.album_art} alt="" />
      ) : (
        <div className="thumb placeholder">♪</div>
      )}
      <div className="qmeta">
        <div className="qname">{item.name}</div>
        <div className="qsub">
          {item.artists}
          {item.requested_by && <> · запрос от {item.requested_by}</>}
          {item.duration_ms > 0 && <> · {fmtDuration(item.duration_ms)}</>}
        </div>
        {item.status === 'failed' && item.error && (
          <div className="qerr">{item.error}</div>
        )}
      </div>
      <span className={`status s-${item.status}`}>{STATUS_LABEL[item.status]}</span>
      <div className="qbtns">
        {item.status === 'failed' && (
          <button className="ghost" onClick={() => onRetry(item.id)} title="Повторить">↻</button>
        )}
        {item.active && (
          <button className="ghost" onClick={() => onRemove(item.id)} title="Убрать">✕</button>
        )}
      </div>
    </div>
  );
}
