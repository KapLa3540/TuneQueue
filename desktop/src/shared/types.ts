// Общие типы главного процесса, рендерера и прелоада.

export type ItemStatus = 'queued' | 'playing' | 'done' | 'skipped' | 'failed';

export interface QueueItem {
  id: number;
  trackId: string;
  url: string;
  title: string; // до обогащения — сам URL
  artist: string;
  thumb: string | null;
  by: string;
  status: ItemStatus;
  error: string | null;
  at: number;
  playedAt: number | null;
}

export interface ChatState {
  connected: boolean;
  joined: boolean;
  channel: string;
  canSend: boolean;
  loggedIn: boolean;
  nick: string | null;
  error: string | null;
}

export interface PlayerState {
  installed: boolean;
  found: boolean;
  title: string;
  artist: string;
  playback: 'playing' | 'paused' | 'other' | 'none';
  posMs: number;
  durMs: number;
  mode: 'off' | 'idle' | 'injecting' | 'serving';
  servingId: number | null;
  sessions: string[];
}

export interface DeviceFlowState {
  code: string;
  uri: string;
  expiresAt: number;
  status: 'waiting' | 'done' | 'error';
  error: string | null;
}

export interface AuthState {
  hasToken: boolean;
  nick: string | null;
  clientId: string;
  device: DeviceFlowState | null;
}

export interface AppState {
  version: number;
  channel: string;
  autoplay: boolean;
  notify: boolean;
  debugChat: boolean;
  chat: ChatState;
  player: PlayerState;
  auth: AuthState;
  queue: QueueItem[];
  notice: string | null;
  events: { t: number; text: string }[];
}

export type Action =
  | { type: 'setChannel'; channel: string }
  | { type: 'disconnect' }
  | { type: 'setAutoplay'; on: boolean }
  | { type: 'setNotify'; on: boolean }
  | { type: 'setDebug'; on: boolean }
  | { type: 'removeItem'; id: number }
  | { type: 'clearFinished' }
  | { type: 'clearQueue' }
  | { type: 'setClientId'; clientId: string }
  | { type: 'twitchLogin' }
  | { type: 'twitchLogout' }
  | { type: 'dismissNotice' };

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** данные ответа (например, device code) */
  data?: unknown;
}

export const IPC = {
  getState: 'tq:getState',
  action: 'tq:action',
  statePush: 'tq:state',
} as const;
