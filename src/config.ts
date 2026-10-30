import 'dotenv/config';

const env = process.env;

function stripSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export const config = {
  port: Number(env.PORT || 8787),
  baseUrl: stripSlash(env.BASE_URL || 'http://localhost:5173'),
  spotifyClientId: env.SPOTIFY_CLIENT_ID || '',
  spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET || '',
  twitchBotNick: env.TWITCH_BOT_NICK || '',
  twitchBotOAuth: env.TWITCH_BOT_OAUTH || '',
  dbPath: env.DB_PATH || 'data/tunequeue.db',
};

export function checkConfig(): void {
  const missing: string[] = [];
  if (!config.spotifyClientId) missing.push('SPOTIFY_CLIENT_ID');
  if (missing.length) {
    console.warn(
      `[config] Отсутствуют переменные: ${missing.join(', ')}. ` +
        `Подключение Spotify работать не будет (см. .env.example)`,
    );
  }
}
