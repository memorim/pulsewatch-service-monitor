import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { listenHost } from '../storage.js';

test('configured disk preserves monitor records across independent processes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pulsewatch-disk-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, NODE_ENV: 'test', PULSEWATCH_DATA_DIRECTORY: directory };
  const run = (source) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env,
      encoding: 'utf8',
    });
  run(
    "import {createDb} from './server.js'; const db=createDb(); db.prepare('INSERT INTO monitors(name,url,status) VALUES(?,?,?)').run('Disk probe','https://example.com','unknown'); db.close();",
  );
  assert.equal(existsSync(join(directory, 'pulsewatch.db')), true);
  assert.equal(
    run(
      "import {createDb} from './server.js'; const db=createDb(); console.log(db.prepare('SELECT count(*) n FROM monitors WHERE name=?').get('Disk probe').n); db.close();",
    ).trim(),
    '1',
  );
});

test('public data paths and unauthenticated external binds fail closed', () => {
  for (const directory of [resolve('public'), resolve('public/private')])
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {dataDirectory} from './storage.js'; dataDirectory();",
        ],
        { env: { ...process.env, PULSEWATCH_DATA_DIRECTORY: directory }, stdio: 'pipe' },
      ),
    );
  assert.equal(listenHost({}), '127.0.0.1');
  assert.throws(() => listenHost({ HOST: '0.0.0.0' }));
  assert.equal(
    listenHost({ HOST: '0.0.0.0', APP_PUBLIC_ORIGIN: 'https://monitor.example' }),
    '0.0.0.0',
  );
});
