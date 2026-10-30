import type { Store } from './store.js';

const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const SCOPES = 'chat:read chat:edit';

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type TokenResult =
  | { kind: 'pending' }
  | { kind: 'slow' }
  | { kind: 'success'; access_token: string; refresh_token?: string; expires_in?: number }
  | { kind: 'error'; message: string };

/** Классификация ответа token-endpoint (выделена для тестов). */
export function classifyTokenResponse(status: number, body: unknown): TokenResult {
  const msg = (body as { message?: string; error?: string; error_description?: string }) ?? {};
  const text = String(msg.message ?? msg.error ?? msg.error_description ?? '').toLowerCase();
  if (status === 200 && (body as { access_token?: string }).access_token) {
    const b = body as { access_token: string; refresh_token?: string; expires_in?: number };
    return { kind: 'success', access_token: b.access_token, refresh_token: b.refresh_token, expires_in: b.expires_in };
  }
  if (text.includes('authorization_pending') || status === 428) return { kind: 'pending' };
  if (text.includes('slow_down')) return { kind: 'slow' };
  if (text.includes('expired_token')) return { kind: 'error', message: 'Код истёк — начни заново' };
  if (text.includes('access_denied')) return { kind: 'error', message: 'Авторизация отклонена' };
  if (text) return { kind: 'error', message: text };
  return { kind: 'error', message: `HTTP ${status}` };
}

export interface AuthEvents {
  onUpdate(): void;
  onToken(token: string, nick: string): void;
  onLogout(): void;
}

/**
 * Вход через Twitch Device Code: приложение показывает код,
 * стример открывает страницу и вводит код. Токен хранится локально.
 */
export class TwitchAuth {
  private device: { info: DeviceStart; deadline: number; timer: NodeJS.Timeout | null } | null = null;

  constructor(
    private readonly store: Store,
    private readonly events: AuthEvents,
  ) {}

  getDevice(): DeviceStart | null {
    return this.device?.info ?? null;
  }

  /** Проверка/обновление сохранённого токена при старте. */
  async validateStored(): Promise<void> {
    const cfg = this.store.cfg;
    if (!cfg.twitchToken || !cfg.twitchClientId) return;
    try {
      const nick = await fetchLogin(cfg.twitchClientId, cfg.twitchToken);
      if (nick) this.events.onToken(cfg.twitchToken, nick);
      else this.logout();
    } catch {
      /* оставляем как есть — проверит IRC */
    }
  }

  async begin(): Promise<DeviceStart> {
    const { twitchClientId } = this.store.cfg;
    if (!twitchClientId) throw new Error('Сначала введи Client ID приложения Twitch');
    this.cancel();

    const res = await fetch(DEVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: twitchClientId, scopes: SCOPES }).toString(),
    });
    if (!res.ok) throw new Error(`Twitch device endpoint: HTTP ${res.status}`);
    const info = (await res.json()) as DeviceStart;
    this.device = { info, deadline: Date.now() + info.expires_in * 1000, timer: null };
    this.schedulePoll(info.interval ?? 5);
    this.events.onUpdate();
    return info;
  }

  cancel(): void {
    if (this.device?.timer) clearTimeout(this.device.timer);
    this.device = null;
    this.events.onUpdate();
  }

  logout(): void {
    this.cancel();
    this.store.update({ twitchToken: null, twitchRefresh: null, twitchTokenExpires: null, twitchNick: null });
    this.events.onLogout();
    this.events.onUpdate();
  }

  private schedulePoll(interval: number): void {
    if (!this.device) return;
    const wait = Math.max(1, interval) * 1000;
    this.device.timer = setTimeout(() => void this.poll(), wait);
  }

  private async poll(): Promise<void> {
    const dev = this.device;
    if (!dev) return;
    if (Date.now() > dev.deadline) {
      this.cancel();
      return;
    }
    const { twitchClientId } = this.store.cfg;
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: twitchClientId,
          scopes: SCOPES,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: dev.info.device_code,
        }).toString(),
      });
      const body: unknown = await res.json().catch(() => ({}));
      const result = classifyTokenResponse(res.status, body);

      if (result.kind === 'pending') {
        this.schedulePoll(dev.info.interval ?? 5);
        return;
      }
      if (result.kind === 'slow') {
        this.schedulePoll((dev.info.interval ?? 5) + 5);
        return;
      }
      if (result.kind === 'error') {
        this.cancel();
        throw new Error(result.message);
      }

      // success
      const nick = await fetchLogin(twitchClientId, result.access_token);
      if (!nick) throw new Error('Не удалось получить логин Twitch');
      this.store.update({
        twitchToken: result.access_token,
        twitchRefresh: result.refresh_token ?? null,
        twitchTokenExpires: result.expires_in ? Date.now() + result.expires_in * 1000 : null,
        twitchNick: nick,
      });
      this.cancel();
      this.events.onToken(result.access_token, nick);
    } catch (err) {
      console.error('[twitch-auth]', err);
      if (this.device) this.schedulePoll(dev.info.interval ?? 5);
    }
  }
}

/** helix/users — подтверждает токен и возвращает логин. */
export async function fetchLogin(clientId: string, token: string): Promise<string | null> {
  const res = await fetch('https://api.twitch.tv/helix/users', {
    headers: {
      'Client-Id': clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: Array<{ login?: string }> };
  return data.data?.[0]?.login ?? null;
}

/** Тихое обновление refresh-токена (если он есть). */
export async function refreshStoredToken(store: Store): Promise<void> {
  const { twitchClientId, twitchRefresh, twitchTokenExpires } = store.cfg;
  if (!twitchClientId || !twitchRefresh) return;
  if (twitchTokenExpires && twitchTokenExpires - Date.now() > 10 * 60_000) return;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: twitchClientId,
        grant_type: 'refresh_token',
        refresh_token: twitchRefresh,
      }).toString(),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!body.access_token) return;
    store.update({
      twitchToken: body.access_token,
      twitchRefresh: body.refresh_token ?? twitchRefresh,
      twitchTokenExpires: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
    });
  } catch {
    /* сбой не критичен */
  }
}
