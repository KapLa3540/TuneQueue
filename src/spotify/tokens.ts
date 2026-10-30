import type { Channel } from '../db.js';
import { refreshAccessToken } from './auth.js';
import { saveTokens } from '../db.js';

/**
 * Возвращает валидный access token канала, при необходимости рефрешит.
 * null — если рефреш не удался (нужно переподключить Spotify).
 */
export async function ensureValidToken(channel: Channel): Promise<string | null> {
  if (!channel.access_token) return null;
  const now = Date.now();
  if (channel.token_expires_at && channel.token_expires_at - now > 60_000) {
    return channel.access_token;
  }
  if (!channel.refresh_token) return channel.access_token; // последняя попытка
  try {
    const res = await refreshAccessToken(channel.refresh_token);
    const expiresAt = Date.now() + res.expires_in * 1000;
    saveTokens(channel.id, res.access_token, res.refresh_token ?? null, expiresAt);
    return res.access_token;
  } catch (err) {
    console.error(`[spotify] refresh failed for #${channel.twitch_channel}:`, err);
    return null;
  }
}
