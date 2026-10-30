import { spawn } from 'child_process';

export interface SpotifyMediaState {
  found: boolean;
  title: string;
  artist: string;
  album: string;
  playback: 'playing' | 'paused' | 'other' | 'none';
  posMs: number;
  durMs: number;
  sessions: string[];
}

export const emptyState = (): SpotifyMediaState => ({
  found: false,
  title: '',
  artist: '',
  album: '',
  playback: 'none',
  posMs: 0,
  durMs: 0,
  sessions: [],
});

/**
 * PowerShell-скрипт: читает состояние плеера Spotify через WinRT SMTC
 * (System Media Transport Controls) — работает на чистом Windows 10/11,
 * без каких-либо API Spotify.
 */
export const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $mgrT = 'Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime'
  $mgrOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()
  $mgrTask = [System.WindowsRuntimeSystemExtensions]::AsTask($mgrOp)
  if (-not $mgrTask.Wait(4000)) { Write-Output '{\\"found\\":false}'; exit 0 }
  $mgr = $mgrTask.Result
  $sessions = $mgr.GetSessions()
  $sp = $null
  foreach ($s in $sessions) {
    $id = [string]$s.SourceAppUserModelId
    if ($id -and $id.ToLower().Contains('spotify')) { $sp = $s; break }
  }
  if ($null -eq $sp) { Write-Output '{\\"found\\":false}'; exit 0 }
  $mpOp = $sp.TryGetMediaPropertiesAsync()
  $mpTask = [System.WindowsRuntimeSystemExtensions]::AsTask($mpOp)
  [void]$mpTask.Wait(2000)
  $mp = $mpTask.Result
  $tl = $sp.GetTimelineProperties()
  $pb = $sp.PlaybackInfo
  $ids = @()
  foreach ($s in $sessions) { $ids += [string]$s.SourceAppUserModelId }
  $obj = [ordered]@{
    found = $true
    title = [string]$mp.Title
    artist = [string]$mp.Artist
    album = [string]$mp.AlbumTitle
    playback = [int]$pb.PlaybackStatus
    posMs = [int64]$tl.Position.TotalMilliseconds
    startMs = [int64]$tl.StartTime.TotalMilliseconds
    endMs = [int64]$tl.EndTime.TotalMilliseconds
    sessions = $ids
  }
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
} catch {
  Write-Output '{\\"found\\":false}'
}
`.trim();

interface PsPayload {
  found?: boolean;
  title?: string;
  artist?: string;
  album?: string;
  playback?: number;
  posMs?: number;
  startMs?: number;
  endMs?: number;
  sessions?: string[];
}

/** Разбор JSON, который вернул PowerShell. Тестируется отдельно. */
export function parseSmtc(raw: string): SpotifyMediaState {
  const st = emptyState();
  try {
    const trimmed = raw.trim();
    const brace = trimmed.indexOf('{');
    if (brace < 0) return st;
    const data = JSON.parse(trimmed.slice(brace)) as PsPayload;
    if (!data.found) return st;
    st.found = true;
    st.title = String(data.title ?? '');
    st.artist = String(data.artist ?? '');
    st.album = String(data.album ?? '');
    st.playback =
      data.playback === 4 ? 'playing' : data.playback === 5 ? 'paused' : data.found ? 'other' : 'none';
    st.posMs = Number(data.posMs ?? 0) || 0;
    const dur = Number(data.endMs ?? 0) - Number(data.startMs ?? 0);
    st.durMs = dur > 0 ? dur : 0;
    st.sessions = Array.isArray(data.sessions) ? data.sessions.map(String) : [];
  } catch {
    return emptyState();
  }
  return st;
}

export async function readSmtc(timeoutMs = 8000): Promise<SpotifyMediaState> {
  if (process.platform !== 'win32') return emptyState();
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(emptyState());
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', () => {
      clearTimeout(timer);
      if (!out.trim() && err.trim()) console.error('[smtc]', err.slice(0, 300));
      resolve(parseSmtc(out));
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(emptyState());
    });
  });
}
