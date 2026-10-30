import { spawn, execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { readSmtc, type SpotifyMediaState } from './smtc.js';

export interface PlayerPort {
  /** установлен ли Spotify (есть ли протокол spotify:) */
  installed(): boolean;
  /** запустить трек в локальном плеере по его track id */
  spawnTrack(trackId: string): Promise<void>;
  /** текущее состояние плеера */
  read(): Promise<SpotifyMediaState>;
}

/** Windows: запуск через протокол spotify:track:... + чтение состояния через SMTC. */
export class WindowsPlayer implements PlayerPort {
  private installedCache: boolean | null = null;

  installed(): boolean {
    if (this.installedCache !== null) return this.installedCache;
    // быстрая эвристика: дефолтная установка или protocol handler
    const appData = process.env.APPDATA ?? '';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const candidates = [
      path.join(appData, 'Spotify', 'Spotify.exe'),
      path.join(localAppData, 'Packages', 'SpotifyAB.SpotifyMusic_zspdnek9z7v0', 'LocalCache', 'Spotify', 'Spotify.exe'),
    ];
    this.installedCache = candidates.some((p) => existsSync(p));
    if (this.installedCache) return true;
    // последняя попытка: protocol handler в реестре
    try {
      execFile('reg', ['query', 'HKCU\\Software\\Classes\\spotify'], { windowsHide: true }, (err) => {
        this.installedCache = !err;
      });
    } catch {
      /* ignore */
    }
    return this.installedCache;
  }

  async spawnTrack(trackId: string): Promise<void> {
    if (!/^[A-Za-z0-9]{22}$/.test(trackId)) throw new Error('bad track id');
    const uri = `spotify:track:${trackId}`;
    return new Promise((resolve, reject) => {
      // cmd start поручает Shell обработать протокол spotify: — откроет/сыграет клиент
      const child = spawn('cmd.exe', ['/c', 'start', '', uri], {
        windowsHide: true,
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`start exited with ${code}`));
      });
    });
  }

  read(): Promise<SpotifyMediaState> {
    return readSmtc();
  }
}

/** Заглушка для разработки вне Windows (UI и тесты работают, плеер «не найден»). */
export class StubPlayer implements PlayerPort {
  installed(): boolean {
    return false;
  }
  async spawnTrack(): Promise<void> {
    throw new Error('Плеер доступен только на Windows');
  }
  async read() {
    const { emptyState } = await import('./smtc.js');
    return emptyState();
  }
}

export function createPlayer(): PlayerPort {
  return process.platform === 'win32' ? new WindowsPlayer() : new StubPlayer();
}
