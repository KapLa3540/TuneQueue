import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

export interface Config {
  channel: string;
  autoplay: boolean;
  notify: boolean;
  debugChat: boolean;
  twitchClientId: string;
  twitchToken: string | null;
  twitchRefresh: string | null;
  twitchTokenExpires: number | null;
  twitchNick: string | null;
}

export const defaultConfig = (): Config => ({
  channel: '',
  autoplay: true,
  notify: true,
  debugChat: false,
  twitchClientId: '',
  twitchToken: null,
  twitchRefresh: null,
  twitchTokenExpires: null,
  twitchNick: null,
});

export function defaultConfigDir(): string {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'TuneQueue');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'TuneQueue');
  return path.join(os.homedir(), '.config', 'tunequeue');
}

export class Store {
  readonly dir: string;
  private readonly file: string;
  cfg: Config;

  constructor(dir?: string) {
    this.dir = dir ?? defaultConfigDir();
    this.file = path.join(this.dir, 'config.json');
    this.cfg = { ...defaultConfig(), ...this.loadFile() };
  }

  private loadFile(): Partial<Config> {
    try {
      if (!existsSync(this.file)) return {};
      return JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Config>;
    } catch {
      return {};
    }
  }

  update(patch: Partial<Config>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.save();
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cfg, null, 2), 'utf8');
  }
}
