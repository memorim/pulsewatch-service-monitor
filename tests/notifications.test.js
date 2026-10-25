import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
process.env.NODE_ENV = 'test';
const { createDb } = await import('../server.js');
const { checkMonitor } = await import('../monitoring.js');
const { webhookConfig, sendWebhook, notificationRunner } = await import('../notifications.js');
const config = webhookConfig({
  MONITOR_WEBHOOK_URL: 'https://notify.example/events',
  MONITOR_WEBHOOK_TOKEN: 'fixture-only-token',
});
function incident(db) {
  return Number(
    db
      .prepare(
        "INSERT INTO incidents(title,detail,severity,status,started_at) VALUES('Fixture event','Fixture details','major','investigating','2026-10-25T00:00:00Z')",
      )
      .run().lastInsertRowid,
  );
}
const read = (db) => db.prepare('SELECT * FROM notification_outbox ORDER BY id').all();

test('incident open/close events are atomic, unique and survive database reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-events-'));
  let db;
  try {
    const file = join(dir, 'fixture.sqlite');
    db = createDb(file);
    const monitor = db.prepare('SELECT * FROM monitors LIMIT 1').get();
    const down = async () => ({ ok: false, statusCode: 503, responseMs: 5, error: 'http_503' });
    await checkMonitor(db, monitor, { check: down });
    assert.equal(read(db).length, 0);
    await checkMonitor(db, monitor, { check: down });
    await checkMonitor(db, monitor, { check: down });
    assert.equal(read(db).length, 1);
    await checkMonitor(db, monitor, {
      check: async () => ({ ok: true, statusCode: 200, responseMs: 2, error: null }),
    });
    await checkMonitor(db, monitor, {
      check: async () => ({ ok: true, statusCode: 200, responseMs: 2, error: null }),
    });
    assert.deepEqual(
      read(db).map((row) => JSON.parse(row.payload).event),
      ['incident.opened', 'incident.closed'],
    );
    db.exec('BEGIN');
    incident(db);
    db.exec('ROLLBACK');
    assert.equal(read(db).length, 2);
    db.close();
    db = createDb(file);
    assert.equal(read(db).length, 2);
  } finally {
    db?.close();
    assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disabled notifications do not send; concurrent dispatch is bounded and retries stop at five', async () => {
  const db = createDb(':memory:');
  try {
    incident(db);
    let calls = 0,
      now = Date.now();
    const logs = [];
    const disabled = notificationRunner(db, {
      config: null,
      send: () => {
        throw new Error('not allowed');
      },
    });
    assert.equal(await disabled.run(), false);
    assert.equal(read(db)[0].attempts, 0);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const runner = notificationRunner(db, {
      config,
      clock: () => now,
      log: (line) => logs.push(line),
      send: async () => {
        calls++;
        if (calls === 1) await gate;
        throw new Error('secret-url-and-token');
      },
    });
    const first = runner.run();
    assert.equal(await runner.run(), false);
    release();
    await first;
    await runner.run();
    assert.equal(calls, 1);
    for (let i = 0; i < 4; i++) {
      now += 300001;
      await runner.run();
    }
    now += 300001;
    await runner.run();
    assert.equal(calls, 5);
    assert.ok(read(db)[0].failed_at);
    assert.equal(read(db)[0].attempts, 5);
    assert.ok(
      logs.every(
        (line) =>
          !line.includes('secret') &&
          !line.includes('fixture-only-token') &&
          !line.includes('https:'),
      ),
    );
    await runner.stop();
  } finally {
    db.close();
  }
});

test('stale delivery lease is recovered, including a crash on the last attempt', async () => {
  const db = createDb(':memory:');
  try {
    incident(db);
    let now = Date.now(),
      sent = 0;
    db.prepare('UPDATE notification_outbox SET attempts=1,lease_until=?').run(now + 20000);
    const runner = notificationRunner(db, {
      config,
      clock: () => now,
      send: async () => {
        sent++;
      },
    });
    await runner.run();
    assert.equal(sent, 0);
    now += 20001;
    await runner.run();
    assert.equal(sent, 1);
    assert.ok(read(db)[0].delivered_at);
    incident(db);
    db.prepare(
      'UPDATE notification_outbox SET attempts=5,lease_until=? WHERE delivered_at IS NULL',
    ).run(now - 1);
    await runner.run();
    assert.equal(sent, 1);
    assert.ok(read(db)[1].failed_at);
    await runner.stop();
  } finally {
    db.close();
  }
});

test('shutdown cancels and drains delivery before the database is closed', async () => {
  const db = createDb(':memory:');
  try {
    incident(db);
    let begin;
    const started = new Promise((resolve) => (begin = resolve));
    const runner = notificationRunner(db, {
      config,
      log: () => {},
      send: async (_config, _row, { signal }) => {
        begin();
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
    });
    const active = runner.run();
    await started;
    await runner.stop();
    await active;
    assert.equal(read(db)[0].last_error, 'shutdown');
    assert.equal(read(db)[0].lease_until, 0);
    assert.equal(await runner.run(), false);
  } finally {
    db.close();
  }
});

test('webhook sends JSON and stable key to a local mock; redirects never receive credentials', async () => {
  const received = [];
  let status = 204;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const data of req) body += data;
    received.push({ headers: req.headers, body });
    res.writeHead(status, { Location: 'https://other.example/private' });
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const row = {
    event_key: 'incident:42:opened',
    payload: JSON.stringify({ event: 'incident.opened', incidentId: 42 }),
  };
  const options = {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (_url, options, callback) => {
      options.lookup('ignored', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
      // Test-only transport adapter: actual production sockets always use the pinned public address and TLS.
      return http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          method: options.method,
          headers: options.headers,
          signal: options.signal,
        },
        callback,
      );
    },
  };
  try {
    await sendWebhook(config, row, options);
    assert.equal(received[0].body, row.payload);
    assert.equal(received[0].headers['idempotency-key'], row.event_key);
    assert.equal(received[0].headers.authorization, 'Bearer fixture-only-token');
    status = 302;
    await assert.rejects(
      () => sendWebhook(config, row, options),
      (error) => error.code === 'http_error',
    );
    assert.equal(received.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('webhook URL/DNS checks reject non-public, malformed and mixed DNS answers before connecting', async () => {
  for (const url of [
    'http://notify.example/',
    'https://user:pass@notify.example/',
    'https://notify.example/?token=x',
    'https://notify.example:8443/',
  ])
    assert.throws(() => webhookConfig({ MONITOR_WEBHOOK_URL: url }));
  assert.throws(() =>
    webhookConfig({
      MONITOR_WEBHOOK_URL: 'https://notify.example/',
      MONITOR_WEBHOOK_TOKEN: 'x\r\nx:y',
    }),
  );
  for (const addresses of [
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
    [{ address: '8.8.8.8', family: 6 }],
    [],
  ]) {
    await assert.rejects(
      () =>
        sendWebhook(
          config,
          { event_key: 'x', payload: '{}' },
          {
            resolve: async () => addresses,
            request: () => {
              throw new Error('must-not-connect');
            },
          },
        ),
      /non_public_address/,
    );
  }
});
