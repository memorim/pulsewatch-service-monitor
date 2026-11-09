import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = resolve('.neon-build');
await mkdir(output, { recursive: true });
const bundle = await build({
  entryPoints: ['scheduled-monitoring.js'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  write: false,
  minify: true,
  external: ['pg-native'],
  banner: {
    js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);",
  },
});
await writeFile(resolve(output, 'index.mjs'), bundle.outputFiles[0].contents);
const compiled = await import(pathToFileURL(resolve(output, 'index.mjs')));
const denied = await compiled.default.fetch(
  new Request('https://build-check.invalid/cron', { method: 'POST' }),
);
if (denied.status !== 401)
  throw new Error('Compiled monitoring handler must reject an anonymous invocation');
const archive = zipSync(
  {
    'index.mjs': bundle.outputFiles[0].contents,
    'postgres-schema.sql': new Uint8Array(await readFile('postgres-schema.sql')),
    'postgres-notifications.sql': new Uint8Array(await readFile('postgres-notifications.sql')),
  },
  { level: 9 },
);
await writeFile(resolve(output, 'monitoring.zip'), archive);
console.log(
  JSON.stringify({
    artifact: '.neon-build/monitoring.zip',
    bytes: archive.length,
  }),
);
