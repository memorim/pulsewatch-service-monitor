import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import pg from 'pg';
import { createPostgresDb, postgresConfig, postgresSql } from '../postgres.js';
import { checkMonitor, monitorRunner } from '../monitoring.js';
import { notificationRunner, runNotificationBatch } from '../notifications.js';
process.env.NODE_ENV = 'test';
const { createApp, createDb } = await import('../server.js');

test('PostgreSQL binds values and requires verified remote TLS', () => {
  const sql = postgresSql("SELECT '?' literal FROM monitors WHERE name=?", ["' OR 1=1"]);
  assert.deepEqual(sql.values, ["' OR 1=1"]);
  assert.equal(sql.text, "SELECT '?' literal FROM pulsewatch.monitors WHERE name=$1");
  for (const suffix of ['', '?sslmode=disable', '?sslmode=verify-full&ssl=false'])
    assert.throws(() => postgresConfig('postgresql://owner:secret@db.example/pulsewatch' + suffix));
  assert.equal(
    postgresConfig('postgresql://owner:secret@db.example/pulsewatch?sslmode=verify-full').ssl
      .rejectUnauthorized,
    true,
  );
});

test(
  'PostgreSQL persists measured history and atomic events, serializes cycles and recovers delivery leases',
  { skip: !process.env.TEST_POSTGRES_URL },
  async () => {
    const url = process.env.TEST_POSTGRES_URL;
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname),
      'Use an isolated local PostgreSQL fixture',
    );
    const admin = new pg.Pool({ connectionString: url });
    const stores = [],
      runners = [];
    const open = async () => {
      const db = await createPostgresDb(url, { seed: () => createDb(':memory:') });
      stores.push(db);
      return db;
    };
    let releaseCycle = () => {},
      releaseDelivery = () => {};
    const oldOrigin = process.env.APP_PUBLIC_ORIGIN,
      oldToken = process.env.APP_OPERATOR_TOKEN;
    process.env.APP_PUBLIC_ORIGIN = 'https://pulsewatch.example';
    process.env.APP_OPERATOR_TOKEN = 'o'.repeat(48);
    const call = (app, method, path, authenticated = true) => {
      const req = request(app)[method](path).set('Host', 'pulsewatch.example');
      if (authenticated) req.auth('operator', process.env.APP_OPERATOR_TOKEN);
      return req;
    };
    try {
      const first = await open(),
        second = await open();
      assert.equal(first.initialized, true);
      assert.equal(second.initialized, false);
      const a = createApp(first),
        b = createApp(second);
      assert.equal((await call(a, 'get', '/api/overview', false)).status, 401);
      assert.equal((await call(a, 'get', '/api/health')).status, 200);
      const monitor = await first.prepare('SELECT * FROM monitors ORDER BY id LIMIT 1').get();
      const failed = async () => ({
        ok: false,
        statusCode: 503,
        responseMs: 20,
        error: 'http_503',
      });
      await checkMonitor(first, monitor, { check: failed });
      await Promise.all([
        checkMonitor(first, monitor, { check: failed }),
        checkMonitor(second, monitor, { check: failed }),
      ]);
      assert.equal(
        (await first.prepare("SELECT count(*) n FROM incidents WHERE status!='resolved'").get()).n,
        1,
      );
      assert.equal((await first.prepare('SELECT count(*) n FROM notification_outbox').get()).n, 1);
      await checkMonitor(second, monitor, {
        check: async () => ({ ok: true, statusCode: 200, responseMs: 12, error: null }),
      });
      const overview = await call(a, 'get', '/api/overview');
      assert.equal(overview.status, 200);
      assert.equal(overview.body.monitors[0].uptime, 25);
      assert.equal(overview.body.monitors[0].check_count, 4);
      assert.equal(typeof overview.body.history[0].response_ms, 'number');
      assert.equal(overview.body.incidents[0].status, 'resolved');
      assert.equal((await first.prepare('SELECT count(*) n FROM notification_outbox').get()).n, 2);
      let cycleStarted;
      const cycleReady = new Promise((resolve) => {
        cycleStarted = resolve;
      });
      const cycleGate = new Promise((resolve) => {
        releaseCycle = resolve;
      });
      const running = monitorRunner(first, {
        check: async () => {
          cycleStarted();
          await cycleGate;
          return { ok: true, statusCode: 200, responseMs: 1, error: null };
        },
      });
      const other = monitorRunner(second, {
        check: async () => {
          throw new Error('duplicate cycle');
        },
      });
      runners.push(running, other);
      const activeCycle = running.run();
      await cycleReady;
      assert.equal(await other.run(), false);
      releaseCycle();
      await activeCycle;
      assert.equal((await first.prepare('SELECT count(*) n FROM checks').get()).n, 8);
      const config = { kind: 'ntfy', url: new URL('https://ntfy.sh/'), topic: 'a'.repeat(48) };
      let sends = 0,
        deliveryStarted;
      const deliveryReady = new Promise((resolve) => {
        deliveryStarted = resolve;
      });
      const deliveryGate = new Promise((resolve) => {
        releaseDelivery = resolve;
      });
      const dispatcher = notificationRunner(first, {
        config,
        send: async () => {
          sends++;
          deliveryStarted();
          await deliveryGate;
        },
      });
      runners.push(dispatcher);
      const activeDelivery = dispatcher.run();
      await deliveryReady;
      // The second process can deliver the other event, but cannot claim the leased one.
      const secondBatch = await runNotificationBatch(second, {
        config,
        send: async () => {
          sends++;
        },
      });
      assert.equal(secondBatch.delivered, 1);
      releaseDelivery();
      await activeDelivery;
      assert.equal(sends, 2);
      assert.equal(
        (
          await first
            .prepare('SELECT count(*) n FROM notification_outbox WHERE delivered_at IS NOT NULL')
            .get()
        ).n,
        2,
      );
      const duplicate = await Promise.all(
        [a, b].map((app) =>
          call(app, 'post', '/api/monitors').send({
            name: 'One target',
            url: 'https://memorim.github.io/pulsewatch/',
          }),
        ),
      );
      assert.deepEqual(duplicate.map((r) => r.status).sort(), [201, 409]);
      await first
        .prepare(
          "INSERT INTO notification_outbox(event_key,payload,created_at,attempts,lease_until) VALUES('fixture:stale','{}',?,1,?)",
        )
        .run(new Date().toISOString(), Date.now() - 1);
      const failure = await runNotificationBatch(second, {
        config,
        send: async () => {
          throw Object.assign(new Error('fixture'), { code: 'http_error' });
        },
        log: () => {},
      });
      assert.equal(failure.failed, 1);
      const before = await first
        .prepare(
          "SELECT attempts,last_error,delivered_at FROM notification_outbox WHERE event_key='fixture:stale'",
        )
        .get();
      assert.equal(before.attempts, 2);
      assert.equal(before.last_error, 'http_error');
      for (const runner of runners) await runner.stop();
      for (const db of stores) await db.close();
      const reopened = await open();
      assert.equal((await reopened.prepare('SELECT count(*) n FROM checks').get()).n, 8);
      assert.deepEqual(
        await reopened
          .prepare(
            "SELECT attempts,last_error,delivered_at FROM notification_outbox WHERE event_key='fixture:stale'",
          )
          .get(),
        before,
      );
      assert.equal(
        (await call(createApp(reopened), 'get', '/api/overview')).body.monitors.length,
        5,
      );
    } finally {
      releaseCycle();
      releaseDelivery();
      await Promise.allSettled(runners.map((runner) => runner.stop()));
      await Promise.all(stores.map((db) => db.close()));
      await admin.query('DROP SCHEMA IF EXISTS pulsewatch CASCADE');
      await admin.end();
      if (oldOrigin === undefined) delete process.env.APP_PUBLIC_ORIGIN;
      else process.env.APP_PUBLIC_ORIGIN = oldOrigin;
      if (oldToken === undefined) delete process.env.APP_OPERATOR_TOKEN;
      else process.env.APP_OPERATOR_TOKEN = oldToken;
    }
  },
);
