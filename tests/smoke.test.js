import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:http';
process.env.NODE_ENV = 'test';
const { createApp, createDb } = await import('../server.js');

test('smoke checks real HTTP health and fails on a mismatched revision', async () => {
  const previous = process.env.APP_REVISION;
  process.env.APP_REVISION = 'a'.repeat(40);
  const db = createDb(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const env = {
      ...process.env,
      SMOKE_URL: `http://127.0.0.1:${address.port}`,
      EXPECTED_REVISION: 'a'.repeat(40),
    };
    const result = await promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], { env });
    assert.match(result.stdout, /health_smoke/);
    await assert.rejects(() =>
      promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], {
        env: { ...env, EXPECTED_REVISION: 'b'.repeat(40) },
      }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    if (previous === undefined) delete process.env.APP_REVISION;
    else process.env.APP_REVISION = previous;
  }
});

test('smoke checks authenticated operator access and rejects the wrong secret', async () => {
  const previousOrigin = process.env.APP_PUBLIC_ORIGIN,
    previousToken = process.env.APP_OPERATOR_TOKEN;
  const password = 'synthetic-operator-secret-'.repeat(3);
  const db = createDb(':memory:');
  let app;
  const server = createServer((req, res) => app(req, res)).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `127.0.0.1:${server.address().port}`;
    process.env.APP_PUBLIC_ORIGIN = `https://${base}`;
    process.env.APP_OPERATOR_TOKEN = password;
    app = createApp(db);
    const env = {
      ...process.env,
      SMOKE_URL: `http://${base}`,
      SMOKE_USER: 'operator',
      SMOKE_PASSWORD: password,
    };
    const run = (extra) =>
      promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], { env: { ...env, ...extra } });
    const result = await run({});
    assert.match(result.stdout, /health_smoke/);
    assert.ok(!result.stdout.includes(password));
    await assert.rejects(() => run({ SMOKE_PASSWORD: 'wrong' }));
    await assert.rejects(() => run({ SMOKE_PASSWORD: '' }));
    await assert.rejects(() => run({ SMOKE_URL: 'http://remote.example' }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    if (previousOrigin === undefined) delete process.env.APP_PUBLIC_ORIGIN;
    else process.env.APP_PUBLIC_ORIGIN = previousOrigin;
    if (previousToken === undefined) delete process.env.APP_OPERATOR_TOKEN;
    else process.env.APP_OPERATOR_TOKEN = previousToken;
  }
});
