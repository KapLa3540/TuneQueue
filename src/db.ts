import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { config } from './config.js';

export type QueueStatus = 'pending' | 'pushed' | 'playing' | 'played' | 'skipped' | 'failed';

export interface Channel {
  id: number;
  twitch_channel: string;
  setup_token: string;
  spotify_user_id: string | null;
  spotify_display_name: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  created_at: number;
}

export interface QueueItem {
  id: number;
  channel_id: number;
  track_id: string;
  uri: string;
  name: string;
  artists: string;
  album_art: string | null;
  duration_ms: number;
  requested_by: string;
  status: QueueStatus;
  error: string | null;
  attempts: number;
  created_at: number;
}

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  twitch_channel TEXT UNIQUE NOT NULL,
  setup_token TEXT UNIQUE NOT NULL,
  spotify_user_id TEXT,
  spotify_display_name TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  name TEXT NOT NULL,
  artists TEXT NOT NULL,
  album_art TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_channel ON queue(channel_id, status, id);
`);

export function newToken(): string {
  return randomBytes(24).toString('hex');
}

// --- channels ---

const stmts = {
  insertChannel: db.prepare(
    `INSERT INTO channels (twitch_channel, setup_token, created_at) VALUES (?, ?, ?)`,
  ),
  bySetup: db.prepare(`SELECT * FROM channels WHERE setup_token = ?`),
  byTwitch: db.prepare(`SELECT * FROM channels WHERE twitch_channel = ?`),
  allChannels: db.prepare(`SELECT * FROM channels`),
  deleteChannel: db.prepare(`DELETE FROM channels WHERE setup_token = ?`),
  saveSpotify: db.prepare(
    `UPDATE channels SET spotify_user_id = ?, spotify_display_name = ?, access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?`,
  ),
  unlinkSpotify: db.prepare(
    `UPDATE channels SET spotify_user_id = NULL, spotify_display_name = NULL, access_token = NULL, refresh_token = NULL, token_expires_at = NULL WHERE id = ?`,
  ),
  setProfile: db.prepare(`UPDATE channels SET spotify_user_id = ?, spotify_display_name = ? WHERE id = ?`),
  saveTokens: db.prepare(
    `UPDATE channels SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ? WHERE id = ?`,
  ),
} as const;

export function createChannel(twitchChannel: string): Channel {
  const token = newToken();
  const res = stmts.insertChannel.run(twitchChannel, token, Date.now());
  return getChannelById(Number(res.lastInsertRowid))!;
}

export function getChannelById(id: number): Channel | undefined {
  return db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as Channel | undefined;
}

export function getChannelBySetup(token: string): Channel | undefined {
  return stmts.bySetup.get(token) as Channel | undefined;
}

export function getChannelByTwitch(name: string): Channel | undefined {
  return stmts.byTwitch.get(name) as Channel | undefined;
}

export function getAllChannels(): Channel[] {
  return stmts.allChannels.all() as Channel[];
}

export function deleteChannel(token: string): boolean {
  return stmts.deleteChannel.run(token).changes > 0;
}

export function saveSpotifyAuth(
  channelId: number,
  userId: string,
  displayName: string,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number,
): void {
  stmts.saveSpotify.run(userId, displayName, accessToken, refreshToken, expiresAt, channelId);
}

export function unlinkSpotify(channelId: number): void {
  stmts.unlinkSpotify.run(channelId);
}

export function setSpotifyProfile(channelId: number, userId: string, displayName: string): void {
  stmts.setProfile.run(userId, displayName, channelId);
}

export function saveTokens(
  channelId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number,
): void {
  stmts.saveTokens.run(accessToken, refreshToken, expiresAt, channelId);
}

// --- queue ---

const queueStmts = {
  insert: db.prepare(
    `INSERT INTO queue (channel_id, track_id, uri, name, artists, album_art, duration_ms, requested_by, status, created_at)
     VALUES (@channel_id, @track_id, @uri, @name, @artists, @album_art, @duration_ms, @requested_by, 'pending', @created_at)`,
  ),
  listActive: db.prepare(
    `SELECT * FROM queue WHERE channel_id = ? AND status IN ('pending','pushed','playing') ORDER BY id ASC`,
  ),
  listRecent: db.prepare(
    `SELECT * FROM queue WHERE channel_id = ? ORDER BY id DESC LIMIT 60`,
  ),
  pending: db.prepare(
    `SELECT * FROM queue WHERE channel_id = ? AND status = 'pending' ORDER BY id ASC`,
  ),
  byId: db.prepare(`SELECT * FROM queue WHERE id = ?`),
  setStatus: db.prepare(`UPDATE queue SET status = ?, error = ? WHERE id = ?`),
  resetAttempts: db.prepare(`UPDATE queue SET attempts = 0, error = NULL, status = 'pending' WHERE id = ?`),
  bumpAttempts: db.prepare(`UPDATE queue SET attempts = attempts + 1 WHERE id = ?`),
  remove: db.prepare(`DELETE FROM queue WHERE id = ? AND channel_id = ?`),
  clearActive: db.prepare(
    `DELETE FROM queue WHERE channel_id = ? AND status IN ('pending','pushed')`,
  ),
  trimPlayed: db.prepare(
    `DELETE FROM queue WHERE channel_id = ? AND status IN ('played','skipped') AND id NOT IN (
       SELECT id FROM queue WHERE channel_id = ? AND status IN ('played','skipped') ORDER BY id DESC LIMIT 30
     )`,
  ),
  countByStatus: db.prepare(
    `SELECT status, COUNT(*) as c FROM queue WHERE channel_id = ? GROUP BY status`,
  ),
} as const;

export interface NewTrack {
  track_id: string;
  uri: string;
  name: string;
  artists: string;
  album_art: string | null;
  duration_ms: number;
  requested_by: string;
}

export function enqueue(channelId: number, track: NewTrack): QueueItem {
  const res = queueStmts.insert.run({ ...track, channel_id: channelId, created_at: Date.now() });
  return queueStmts.byId.get(Number(res.lastInsertRowid)) as QueueItem;
}

export function listActive(channelId: number): QueueItem[] {
  return queueStmts.listActive.all(channelId) as QueueItem[];
}

export function listRecent(channelId: number): QueueItem[] {
  return queueStmts.listRecent.all(channelId) as QueueItem[];
}

export function listPending(channelId: number): QueueItem[] {
  return queueStmts.pending.all(channelId) as QueueItem[];
}

export function getQueueItem(id: number): QueueItem | undefined {
  return queueStmts.byId.get(id) as QueueItem | undefined;
}

export function setQueueStatus(id: number, status: QueueStatus, error: string | null = null): void {
  queueStmts.setStatus.run(status, error, id);
}

export function resetQueueItem(id: number): void {
  queueStmts.resetAttempts.run(id);
}

export function bumpAttempts(id: number): void {
  queueStmts.bumpAttempts.run(id);
}

export function removeQueueItem(id: number, channelId: number): boolean {
  return queueStmts.remove.run(id, channelId).changes > 0;
}

export function clearActiveQueue(channelId: number): number {
  return queueStmts.clearActive.run(channelId).changes;
}

export function trimPlayedItems(channelId: number): void {
  queueStmts.trimPlayed.run(channelId, channelId);
}

export function queueCounts(channelId: number): Record<string, number> {
  const rows = queueStmts.countByStatus.all(channelId) as { status: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.c;
  return out;
}
