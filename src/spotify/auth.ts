import crypto from 'crypto';
import { config } from '../config.js';

const SCOPES = 'user-modify-playback-state user-read-playback-state';

export interface AuthState {
  verifier: string;
  challenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createAuthState(): AuthState {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(state: string, auth: AuthState): string {
  const params = new URLSearchParams({
    client_id: config.spotifyClientId,
    response_type: 'code',
    redirect_uri: `${config.baseUrl}/api/spotify/callback`,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: auth.challenge,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

function tokenBody(extra: Record<string, string>): string {
  const body: Record<string, string> = { client_id: config.spotifyClientId, ...extra };
  if (config.spotifyClientSecret) body.client_secret = config.spotifyClientSecret;
  return new URLSearchParams(body).toString();
}

async function tokenRequest(body: string): Promise<TokenResponse> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Spotify token endpoint ${res.status}: ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  return tokenRequest(
    tokenBody({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.baseUrl}/api/spotify/callback`,
      code_verifier: verifier,
    }),
  );
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(
    tokenBody({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
}
