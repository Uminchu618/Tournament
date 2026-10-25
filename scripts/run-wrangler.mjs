import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadEnv} from './env.mjs';

loadEnv();
await mkdir('.artifacts/wrangler', {recursive: true});
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve('.artifacts/wrangler')},
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => {process.exitCode = code ?? 1;});
