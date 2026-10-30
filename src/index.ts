import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'fs';
import path from 'path';
import { config, checkConfig } from './config.js';
import { getAllChannels } from './db.js';
import { registerApi } from './routes/api.js';
import { TwitchIrc } from './twitch/irc.js';
import { createCommandHandler } from './twitch/commands.js';
import { startSweeper } from './sweeper.js';

async function main(): Promise<void> {
  checkConfig();

  const app = Fastify({
    logger: {
      transport: undefined,
      level: 'info',
    },
  });

  // Twitch IRC
  const irc = new TwitchIrc((msg) => void handler.handle(msg));
  const handler = createCommandHandler(irc);

  await registerApi(app, irc);

  // Статический фронтенд (после сборки: npm run build)
  const dist = path.resolve('dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[server] listening on :${config.port} (BASE_URL=${config.baseUrl})`);

  // Поднимаем IRC и входим во все ранее подключённые каналы
  irc.start();
  const channels = getAllChannels();
  for (const ch of channels) irc.join(ch.twitch_channel);
  console.log(`[irc] scheduled joins for ${channels.length} channel(s)`);

  startSweeper();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
