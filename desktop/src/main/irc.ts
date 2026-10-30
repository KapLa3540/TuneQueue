import WebSocket from 'ws';

const TWITCH_WS = 'wss://irc-ws.chat.twitch.tv:443';

export interface ChatOpts {
  channel: string;
  token: string | null;
  nick: string | null;
}

export interface ChatEvents {
  onJoined(joined: boolean): void;
  onConnected(connected: boolean): void;
  /** токен отклонён — нужно перелогиниться */
  onAuthError(): void;
  onMessage(user: string, text: string, tags: Record<string, string>): void;
}

/**
 * Подключение к чату Twitch напрямую по IRC/WebSocket.
 * Без токена — анонимное чтение (justinfan), писать не можем.
 * С токеном стримера — читаем и отвечаем от его имени.
 * Открытый чат на рабочем столе не нужен.
 */
export class TwitchChat {
  private ws: WebSocket | null = null;
  private stopped = true;
  private ready = false;
  private joined = false;
  private delay = 1000;
  private lastSay = 0;

  constructor(
    private readonly getOpts: () => ChatOpts,
    private readonly events: ChatEvents,
  ) {}

  get connected(): boolean {
    return this.ready;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  get canSend(): boolean {
    const o = this.getOpts();
    return Boolean(o.token && o.nick);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.joined = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.events.onConnected(false);
    this.events.onJoined(false);
  }

  say(text: string): void {
    if (!this.canSend || !this.ready) return;
    const o = this.getOpts();
    if (!o.channel) return;
    const now = Date.now();
    if (now - this.lastSay < 1300) return; // щадящий лимит
    this.lastSay = now;
    this.send(`PRIVMSG #${o.channel} :${text}`);
  }

  private send(line: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(`${line}\r\n`);
  }

  private connect(): void {
    if (this.stopped) return;
    const o = this.getOpts();
    if (!o.channel) return;

    const ws = new WebSocket(TWITCH_WS);
    this.ws = ws;
    let nick = '';

    ws.on('open', () => {
      if (o.token && o.nick) {
        nick = o.nick.toLowerCase();
        const pass = o.token.startsWith('oauth:') ? o.token : `oauth:${o.token}`;
        ws.send(`PASS ${pass}\r\n`);
        ws.send(`NICK ${nick}\r\n`);
      } else {
        nick = `justinfan${Math.floor(Math.random() * 900000 + 100000)}`;
        ws.send(`NICK ${nick}\r\n`);
      }
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
    });

    ws.on('message', (raw) => {
      for (const line of raw.toString().split('\r\n')) {
        if (line) this.handleLine(line, nick);
      }
    });

    ws.on('close', () => {
      this.ready = false;
      this.joined = false;
      this.events.onConnected(false);
      this.events.onJoined(false);
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    });

    ws.on('error', (err) => {
      console.error('[irc] error:', (err as Error).message);
    });
  }

  private handleLine(line: string, myNick: string): void {
    if (line.startsWith('PING')) {
      this.send(line.replace('PING', 'PONG'));
      return;
    }

    if (/^:tmi\.twitch\.tv\s+001\s/.test(line)) {
      this.ready = true;
      this.delay = 1000;
      this.events.onConnected(true);
      const o = this.getOpts();
      if (o.channel) this.send(`JOIN #${o.channel}`);
      return;
    }

    if (line.includes(' NOTICE ')) {
      if (/Login authentication failed|Improperly formatted auth|Error logging in/i.test(line)) {
        console.error('[irc] auth failed:', line);
        this.events.onAuthError();
      }
      return;
    }

    const sp = line.indexOf(' ');
    const prefix = line.startsWith(':') ? line.slice(1, sp < 0 ? undefined : sp) : '';
    const rest = line.slice(sp + 1);

    if (rest.startsWith('JOIN ') && myNick && prefix.split('!')[0]?.toLowerCase() === myNick) {
      this.joined = true;
      this.events.onJoined(true);
      return;
    }
    if (rest.startsWith('PART ') && myNick && prefix.split('!')[0]?.toLowerCase() === myNick) {
      this.joined = false;
      this.events.onJoined(false);
      return;
    }

    if (rest.startsWith('PRIVMSG ') || line.includes(' PRIVMSG ')) {
      const msg = parsePrivmsg(line);
      if (msg) this.events.onMessage(msg.user, msg.message, msg.tags);
    }
  }
}

export function parsePrivmsg(
  line: string,
): { user: string; message: string; tags: Record<string, string> } | null {
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
  if (command !== 'PRIVMSG') return null;

  let params = rest.slice(sp2 + 1);
  if (params.startsWith(':')) params = params.slice(1);
  const sp3 = params.indexOf(' ');
  if (sp3 < 0) return null;
  const message = params.slice(sp3 + 1);
  const user = prefix.split('!')[0];
  if (!user) return null;
  return { user, message, tags };
}
