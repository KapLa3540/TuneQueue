/** Публичный oEmbed Spotify — без ключей и регистрации. Только для красивых подписей в очереди. */
export interface TrackMeta {
  title: string;
  artist: string;
  thumb: string | null;
}

export async function fetchTrackMeta(url: string, timeoutMs = 5000): Promise<TrackMeta | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    if (!data.title) return null;
    return {
      title: data.title,
      artist: data.author_name ?? '',
      thumb: data.thumbnail_url ?? null,
    };
  } catch {
    return null;
  }
}
