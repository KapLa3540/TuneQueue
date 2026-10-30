export class SpotifyApiError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

const BASE = 'https://api.spotify.com/v1';

interface SpotifyErrorBody {
  error?: { status?: number; message?: string; reason?: string };
}

async function spotifyFetch(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as SpotifyErrorBody;
    const message = data.error?.message || `HTTP ${res.status}`;
    const reason = data.error?.reason || '';
    throw new SpotifyApiError(res.status, reason, message);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// --- типы ---

export interface Track {
  id: string;
  uri: string;
  name: string;
  artists: string;
  album_art: string | null;
  duration_ms: number;
}

interface SearchResponse {
  tracks?: { items: Array<{
    id: string;
    uri: string;
    name: string;
    duration_ms: number;
    artists: Array<{ name: string }>;
    album?: { images?: Array<{ url: string }> };
  }> };
}

export interface Playback {
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

// --- API ---

export async function searchTrack(token: string, query: string): Promise<Track | null> {
  const data = (await spotifyFetch(
    token,
    'GET',
    `/search?q=${encodeURIComponent(query)}&type=track&limit=5`,
  )) as SearchResponse | null;
  const item = data?.tracks?.items?.[0];
  if (!item) return null;
  return {
    id: item.id,
    uri: item.uri,
    name: item.name,
    artists: item.artists.map((a) => a.name).join(', '),
    album_art: item.album?.images?.[0]?.url ?? null,
    duration_ms: item.duration_ms,
  };
}

export async function getTrackById(token: string, id: string): Promise<Track | null> {
  const data = (await spotifyFetch(token, 'GET', `/tracks/${id}`)) as {
    id: string;
    uri: string;
    name: string;
    duration_ms: number;
    artists: Array<{ name: string }>;
    album?: { images?: Array<{ url: string }> };
  } | null;
  if (!data) return null;
  return {
    id: data.id,
    uri: data.uri,
    name: data.name,
    artists: data.artists.map((a) => a.name).join(', '),
    album_art: data.album?.images?.[0]?.url ?? null,
    duration_ms: data.duration_ms,
  };
}

export async function addToQueue(token: string, uri: string): Promise<void> {
  await spotifyFetch(token, 'POST', `/me/player/queue?uri=${encodeURIComponent(uri)}`);
}

export async function nextTrack(token: string): Promise<void> {
  await spotifyFetch(token, 'POST', '/me/player/next');
}

export async function previousTrack(token: string): Promise<void> {
  await spotifyFetch(token, 'POST', '/me/player/previous');
}

export async function setPlaying(token: string, play: boolean): Promise<void> {
  await spotifyFetch(token, 'POST', `/me/player/${play ? 'play' : 'pause'}`);
}

export async function getPlayback(token: string): Promise<Playback | null> {
  return (await spotifyFetch(token, 'GET', '/me/player')) as Playback | null;
}

export async function getCurrentUser(token: string): Promise<{ id: string; display_name: string } | null> {
  return (await spotifyFetch(token, 'GET', '/me')) as { id: string; display_name: string } | null;
}
