import WebSocket from 'ws';

// Реальные каналы с активным чатом + один несуществующий для сравнения
const JOINS = ['#teststreamer_1', '#shroud', '#xqc', '#definitely_not_a_real_channel_9281'];

const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
const nick = 'justinfan' + Math.floor(Math.random() * 900000 + 100000);
const t0 = Date.now();
const log = (s) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, s);

ws.on('open', () => {
  log('OPEN (с CRLF)');
  ws.send(`NICK ${nick}\r\n`);
  ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
  JOINS.forEach((ch, i) => {
    setTimeout(() => { log(`>> JOIN ${ch}`); ws.send(`JOIN ${ch}\r\n`); }, 2000 + i * 2500);
  });
});

ws.on('message', (d) => {
  const s = d.toString();
  for (const line of s.split('\r\n')) {
    if (!line) continue;
    if (line.includes('JOIN') || line.includes('NOTICE') || line.includes(' 001 ') || line.includes('ERROR') || line.includes('404')) {
      log(`<< ${line.slice(0, 150)}`);
    }
  }
});

ws.on('close', (c) => log(`CLOSE ${c}`));
ws.on('error', (e) => log(`ERR ${e.message}`));

setTimeout(() => { ws.close(); process.exit(0); }, 16000);
