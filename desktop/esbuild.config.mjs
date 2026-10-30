import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const withElectron = process.argv.includes('--electron');

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
};

async function copyStatic() {
  await mkdir(path.join(root, 'build/renderer'), { recursive: true });
  await cp(path.join(root, 'src/renderer/index.html'), path.join(root, 'build/renderer/index.html'));
  await cp(path.join(root, 'src/renderer/styles.css'), path.join(root, 'build/renderer/styles.css'));
}

const mainOpts = {
  ...common,
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(root, 'build/main.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
};

const preloadOpts = {
  ...common,
  entryPoints: [path.join(root, 'src/preload.ts')],
  outfile: path.join(root, 'build/preload.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
};

const rendererOpts = {
  ...common,
  entryPoints: [path.join(root, 'src/renderer/app.ts')],
  outfile: path.join(root, 'build/renderer/app.js'),
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
};

async function run() {
  await rm(path.join(root, 'build'), { recursive: true, force: true });
  await copyStatic();

  if (watch) {
    const ctxs = await Promise.all([mainOpts, preloadOpts, rendererOpts].map((o) => context(o)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[esbuild] watching…');
    if (withElectron) {
      const electron = spawn(
        path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron'),
        ['.'],
        { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } },
      );
      electron.on('exit', (code) => {
        if (code !== 0 && code !== null) process.exit(code);
      });
    }
  } else {
    await Promise.all([mainOpts, preloadOpts, rendererOpts].map((o) => build(o)));
    console.log('[esbuild] done');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
