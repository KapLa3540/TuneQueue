import { parseSpotifyTrack, type ParsedTrack } from './queue.js';

const SHORT_HOSTS = new Set(['spotify.link', 'www.spotify.link', 'spotify.app.link']);

/** Короткие ссылки, которые Spotify шарит с телефона. */
export function isSpotifyShortLink(u: string): boolean {
  try {
    const url = new URL(u.startsWith('http') ? u : `https://${u}`);
    return SHORT_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Открыть короткую ссылку (редирект) и вытащить из финального URL трек. */
export async function resolveShortLink(u: string, timeoutMs = 7000): Promise<ParsedTrack | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(u, { redirect: 'follow', signal: ctl.signal });
    clearTimeout(timer);
    return parseSpotifyTrack(res.url);
  } catch {
    return null;
  }
}
