/** Живая проверка класса TwitchChat: доходят ли сообщения через onMessage. */
import { TwitchChat } from '../src/main/irc.js';

const CH = process.argv[2] ?? 'xqc';
let n = 0;
const chat = new TwitchChat(
  () => ({ channel: CH, token: null, nick: null }),
  {
    onConnected: (c) => console.log('connected:', c),
    onJoined: (j) => console.log('joined:', j),
    onAuthError: () => console.log('auth error'),
    onMessage: (u, m) => {
      n++;
      if (n <= 4) console.log(`msg @${u}: ${m.slice(0, 50)}`);
    },
  },
);
chat.start();
setTimeout(() => {
  console.log(`ИТОГ: через onMessage прошло ${n} сообщений`);
  process.exit(n > 0 ? 0 : 1);
}, 12000);
