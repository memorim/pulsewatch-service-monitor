import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { EventEmitter } from 'node:events';
process.env.NODE_ENV = 'test';
const { createDb, createApp } = await import('../server.js');
const { probe, publicAddress, targetUrl, checkMonitor, monitorRunner } =
  await import('../monitoring.js');
test('outbound target validation rejects private IPs, credentials, redirects and DNS rebinding', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.1.1',
    '169.254.169.254',
    '192.168.1.1',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of [
    'ftp://memorim.github.io/',
    'https://user:pass@memorim.github.io/',
    'https://memorim.github.io:8443/',
    'https://memorim.github.io/?token=x',
    'https://not-owned.example/',
  ])
    assert.throws(() => targetUrl(url));
  await assert.rejects(
    () =>
      probe('https://memorim.github.io/', {
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        request: () => {
          throw new Error('must_not_connect');
        },
      }),
    /non_public_address/,
  );
  let calls = 0;
  await assert.rejects(() =>
    probe('https://memorim.github.io/', {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: (_url, options, callback) => {
        calls++;
        options.lookup('ignored', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
        const req = new EventEmitter();
        req.end = () =>
          callback({ statusCode: 302, headers: { location: 'https://127.0.0.1/' }, destroy() {} });
        return req;
      },
    }),
  );
  assert.equal(calls, 1);
});
test('measured failures open one incident, recovery resolves it and ratios use recorded checks', async () => {
  const db = createDb(':memory:');
  try {
    const m = db.prepare('SELECT * FROM monitors LIMIT 1').get();
    let current = { ok: false, statusCode: 503, responseMs: 20, error: 'http_503' };
    const check = async () => current;
    for (let i = 0; i < 3; i++)
      await checkMonitor(db, m, { check, now: new Date(Date.now() + i * 1000).toISOString() });
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM incidents WHERE status!='resolved'").get().n,
      1,
    );
    current = { ok: true, statusCode: 200, responseMs: 12, error: null };
    await checkMonitor(db, m, { check, now: new Date(Date.now() + 4000).toISOString() });
    const overview = await request(createApp(db)).get('/api/overview');
    assert.equal(overview.body.monitors[0].uptime, 25);
    assert.equal(overview.body.monitors[0].response_ms, 12);
    assert.equal(overview.body.incidents[0].status, 'resolved');
    assert.ok(overview.body.incidents[0].resolved_at);
    await request(createApp(db))
      .patch('/api/monitors/1')
      .send({ status: 'operational', responseMs: 1 });
    assert.equal(
      (await request(createApp(db)).get('/api/overview')).body.monitors[0].response_ms,
      null,
    );
  } finally {
    db.close();
  }
});
test('scheduler prevents overlapping cycles and a failed history write cannot publish a partial state', async () => {
  const db = createDb(':memory:');
  try {
    let release;
    const wait = new Promise((resolve) => (release = resolve));
    const runner = monitorRunner(db, {
      check: async () => {
        await wait;
        return { ok: true, statusCode: 200, responseMs: 1, error: null };
      },
    });
    const running = runner.run();
    assert.equal(await runner.run(), false);
    release();
    await running;
    assert.equal(db.prepare('SELECT COUNT(*) n FROM checks').get().n, 4);
    runner.stop();
    const m = db.prepare('SELECT * FROM monitors LIMIT 1').get();
    db.exec(
      "CREATE TRIGGER break_check BEFORE INSERT ON checks BEGIN SELECT RAISE(ABORT,'test');END;",
    );
    await assert.rejects(() =>
      checkMonitor(db, m, {
        check: async () => ({ ok: false, statusCode: 500, responseMs: 2, error: 'http_500' }),
      }),
    );
    assert.equal(
      db.prepare('SELECT status FROM monitors WHERE id=?').get(m.id).status,
      'operational',
    );
  } finally {
    db.close();
  }
});

test('a paused target cannot publish a late in-flight probe result', async () => {
  const db = createDb(':memory:');
  try {
    const monitor = db.prepare('SELECT * FROM monitors LIMIT 1').get();
    let release;
    const pending = checkMonitor(db, monitor, {
      check: () => new Promise((resolve) => (release = resolve)),
    });
    db.prepare("UPDATE monitors SET enabled=0,status='down',status_source='manual' WHERE id=?").run(
      monitor.id,
    );
    release({ ok: true, statusCode: 200, responseMs: 2, error: null });
    await pending;
    assert.equal(db.prepare('SELECT COUNT(*) n FROM checks').get().n, 0);
    assert.equal(
      db.prepare('SELECT status_source FROM monitors WHERE id=?').get(monitor.id).status_source,
      'manual',
    );
  } finally {
    db.close();
  }
});
