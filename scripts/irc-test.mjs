import WebSocket from 'ws';

const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
const nick = 'justinfan' + Math.floor(Math.random() * 900000 + 100000);
const t0 = Date.now();
const log = (s) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, s);

ws.on('open', () => {
  log('OPEN');
  ws.send(`NICK ${nick}`);
  ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
  setTimeout(() => { log('>> JOIN bare #teststreamer_1'); ws.send('JOIN #teststreamer_1'); }, 1500);
  setTimeout(() => { log('>> JOIN bare #another_channel_x'); ws.send('JOIN #another_channel_x'); }, 4500);
  setTimeout(() => { log('>> JOIN crlf #third_channel_y'); ws.send('JOIN #third_channel_y\r\n'); }, 7500);
  setTimeout(() => { log('>> JOIN crlf #fourth_channel_z'); ws.send('JOIN #fourth_channel_z\r\n'); }, 10500);
});

ws.on('message', (d) => {
  const s = d.toString();
  for (const line of s.split('\r\n')) {
    if (line.includes('JOIN') || line.includes(' 001 ') || line.includes('NOTICE') || line.startsWith('PING')) log(`<< ${line.slice(0, 140)}`);
  }
});

ws.on('close', (c) => log(`CLOSE ${c}`));
ws.on('error', (e) => log(`ERR ${e.message}`));

setTimeout(() => { ws.close(); process.exit(0); }, 15000);
