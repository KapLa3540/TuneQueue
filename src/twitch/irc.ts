import WebSocket from 'ws';
import { config } from '../config.js';

export interface Privmsg {
  channel: string; // без '#'
  user: string;
  message: string;
  tags: Record<string, string>;
}

type MessageHandler = (msg: Privmsg) => void;

const TWITCH_WS = 'wss://irc-ws.chat.twitch.tv:443';

/**
 * Один IRC-коннект ко всем Twitch-каналам сразу (multi-channel join).
 * Без токена бота — анонимное подключение (justinfan): читает чат, но не пишет в него.
 */
export class TwitchIrc {
  private ws: WebSocket | null = null;
  private wantJoin = new Set<string>();
  private joined = new Set<string>();
  private reconnectDelay = 1000;
  private stopped = false;
  private ready = false;
  private myNick = '';
  /** когда последний раз отправляли JOIN (канал ещё не подтверждён) */
  private joinSentAt = new Map<string, number>();

  constructor(private onPrivmsg: MessageHandler) {}

  get canSend(): boolean {
    return Boolean(config.twitchBotNick && config.twitchBotOAuth);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  join(channel: string): void {
    const ch = channel.toLowerCase();
    this.wantJoin.add(ch);
    if (this.ready) this.sendJoin(ch);
  }

  part(channel: string): void {
    const ch = channel.toLowerCase();
    this.wantJoin.delete(ch);
    this.joined.delete(ch);
    this.joinSentAt.delete(ch);
    if (this.ready) this.sendRaw(`PART #${ch}`);
  }

  has(channel: string): boolean {
    return this.joined.has(channel.toLowerCase());
  }

  /**
   * Состояние входа бота в канал.
   * Twitch МОЛЧА игнорирует JOIN несуществующих каналов — по таймауту отдаём 'failed'.
   */
  joinState(channel: string): 'joined' | 'joining' | 'failed' | 'none' {
    const ch = channel.toLowerCase();
    if (this.joined.has(ch)) return 'joined';
    if (!this.wantJoin.has(ch)) return 'none';
    const sentAt = this.joinSentAt.get(ch);
    if (sentAt === undefined) return this.ready ? 'failed' : 'joining';
    return Date.now() - sentAt > 10_000 ? 'failed' : 'joining';
  }

  say(channel: string, message: string): void {
    if (!this.canSend) {
      console.log(`[irc:offline -> #${channel}] ${message}`);
      return;
    }
    // Требование Twitch: не более ~20 сообщений / 30 секунд на бота.
    this.sendRaw(`PRIVMSG #${channel.toLowerCase()} :${message}`);
  }

  private sendRaw(line: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(line.endsWith('\r\n') ? line : `${line}\r\n`);
    }
  }

  private sendJoin(ch: string): void {
    this.sendRaw(`JOIN #${ch}`);
    this.joinSentAt.set(ch, Date.now());
  }

  private connect(): void {
    if (this.stopped) return;
    console.log('[irc] connecting to Twitch…');
    const ws = new WebSocket(TWITCH_WS);
    this.ws = ws;

    ws.on('open', () => {
      if (this.canSend) {
        this.myNick = config.twitchBotNick.toLowerCase();
        ws.send(`PASS ${config.twitchBotOAuth}`);
        ws.send(`NICK ${config.twitchBotNick}`);
      } else {
        this.myNick = `justinfan${Math.floor(Math.random() * 900000 + 100000)}`;
        ws.send(`NICK ${this.myNick}`);
      }
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      for (const line of text.split('\r\n')) {
        if (line) this.handleLine(line);
      }
    });

    ws.on('close', () => {
      this.ready = false;
      this.joined.clear();
      if (this.stopped) return;
      console.log(`[irc] disconnected, retry in ${this.reconnectDelay}ms`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });

    ws.on('error', (err) => {
      console.error('[irc] error:', err.message);
    });
  }

  private handleLine(line: string): void {
    if (process.env.IRC_DEBUG) console.log('<<', line);

    // PING -> PONG (keepalive)
    if (line.startsWith('PING')) {
      this.sendRaw(line.replace('PING', 'PONG'));
      return;
    }

    // Приветствие сервера = соединение установлено
    if (/^:tmi\.twitch\.tv\s+001\s/.test(line)) {
      this.ready = true;
      this.reconnectDelay = 1000;
      console.log('[irc] ready, joining channels:', this.wantJoin.size);
      for (const ch of this.wantJoin) this.sendJoin(ch);
      return;
    }

    if (line.includes(' PRIVMSG ')) {
      const msg = this.parsePrivmsg(line);
      if (msg) this.onPrivmsg(msg);
      return;
    }

    if (line.includes(' JOIN ') || line.includes(' PART ')) {
      this.trackMembership(line);
      return;
    }

    if (line.includes(' NOTICE ')) {
      console.log('[irc] NOTICE:', line);
    }
  }

  /** Отслеживаем собственные JOIN/PART, чтобы знать, в каких каналах бот реально состоит. */
  private trackMembership(line: string): void {
    const sp1 = line.indexOf(' ');
    if (sp1 < 0) return;
    const prefix = line.slice(1, sp1);
    const nick = prefix.split('!')[0]?.toLowerCase();
    if (!nick || nick !== this.myNick) return;

    const rest = line.slice(sp1 + 1);
    const sp2 = rest.indexOf(' ');
    const cmd = sp2 < 0 ? rest : rest.slice(0, sp2);
    const chanPart = sp2 < 0 ? '' : rest.slice(sp2 + 1).trim();
    const chan = chanPart.replace(/^[:=]/, '').replace(/^#/, '').toLowerCase();
    if (!chan) return;

    if (cmd === 'JOIN') {
      this.joined.add(chan);
      this.joinSentAt.delete(chan);
      console.log(`[irc] joined #${chan}`);
    } else if (cmd === 'PART' || cmd === 'KICK') {
      this.joined.delete(chan);
      console.log(`[irc] left #${chan}`);
    }
  }

  private parsePrivmsg(line: string): Privmsg | null {
    let rest = line;
    const tags: Record<string, string> = {};

    if (rest.startsWith('@')) {
      const sp = rest.indexOf(' ');
      if (sp < 0) return null;
      for (const pair of rest.slice(1, sp).split(';')) {
        const eq = pair.indexOf('=');
        if (eq > 0) tags[pair.slice(0, eq)] = pair.slice(eq + 1);
        else tags[pair] = '';
      }
      rest = rest.slice(sp + 1);
    }

    if (!rest.startsWith(':')) return null;
    const sp1 = rest.indexOf(' ');
    if (sp1 < 0) return null;
    const prefix = rest.slice(1, sp1);
    rest = rest.slice(sp1 + 1);

    const sp2 = rest.indexOf(' ');
    if (sp2 < 0) return null;
    const command = rest.slice(0, sp2);
    let params = rest.slice(sp2 + 1);
    if (command !== 'PRIVMSG') return null;

    if (params.startsWith(':')) params = params.slice(1);
    const space = params.indexOf(' ');
    if (space < 0) return null;
    const target = params.slice(0, space);
    const message = params.slice(space + 1);

    const user = prefix.split('!')[0];
    if (!target.startsWith('#') || !user) return null;

    return { channel: target.slice(1).toLowerCase(), user, message, tags };
  }
}
