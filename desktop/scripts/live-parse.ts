/** Живая проверка: принимаем реальный чат Twitch и парсим нашим парсером. */
import WebSocket from 'ws';
import { parsePrivmsg } from '../src/main/irc.js';

const CHANNEL = process.argv[2] ?? 'xqc';
const nick = `justinfan${Math.floor(Math.random() * 900000 + 100000)}`;
let parsed = 0;
let commands = 0;

const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

ws.on('open', () => {
  ws.send(`NICK ${nick}\r\n`);
  ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
  ws.send(`JOIN #${CHANNEL}\r\n`);
  console.log(`joined #${CHANNEL} as ${nick}, ждём сообщения…`);
});

ws.on('message', (raw) => {
  for (const line of raw.toString().split('\r\n')) {
    if (!line) continue;
    if (line.startsWith('PING')) {
      ws.send(line.replace('PING', 'PONG'));
      continue;
    }
    if (!line.includes(' PRIVMSG ')) continue;
    const msg = parsePrivmsg(line);
    if (!msg) {
      console.log('РАЗБОР ПРОВАЛЕН:', line.slice(0, 160));
      process.exit(2);
    }
    parsed++;
    if (/^!(sr|play)\b/i.test(msg.message)) {
      commands++;
      console.log(`команда: @${msg.user}: ${msg.message.slice(0, 80)}`);
    } else if (parsed <= 3) {
      console.log(`ok: @${msg.user}: ${msg.message.slice(0, 60)}`);
    }
    if (parsed >= 20) {
      console.log(`\nИТОГ: разобрано ${parsed} сообщений, команд !sr/!play: ${commands} — парсер работает`);
      process.exit(0);
    }
  }
});

ws.on('error', (e) => {
  console.error('WS error:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.log(`\nТаймаут: разобрано ${parsed} (за это время не набралось 20 — парсер работал: ${parsed > 0})`);
  process.exit(parsed > 0 ? 0 : 1);
}, 14000);
