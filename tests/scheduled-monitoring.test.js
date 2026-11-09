import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledHandler } from '../scheduled-monitoring.js';
process.env.NODE_ENV = 'test';
const { createDb } = await import('../server.js');
const config = { kind: 'ntfy', url: new URL('https://ntfy.sh/'), topic: 'a'.repeat(48) };
function tick(header = 'fixture', bodyId = 'fixture', name = 'pulsewatch-monitoring') {
  return new Request('https://fixture.example/cron', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-neon-trigger-invocation-id': header },
    body: JSON.stringify({
      version: 1,
      invocation_id: bodyId,
      trigger: { type: 'schedule', id: 'trigger-fixture', name },
      data: { scheduled_at: '2026-11-09T00:00:00Z' },
    }),
  });
}
test('scheduled monitoring rejects unauthenticated or unexpected triggers before database access', async () => {
  let opened = 0;
  const handler = createScheduledHandler({
    open: () => {
      opened++;
      throw Error('must not open');
    },
  });
  assert.equal(
    (await handler.fetch(new Request('https://fixture.example/cron', { method: 'POST' }))).status,
    401,
  );
  assert.equal((await handler.fetch(tick('a', 'b'))).status, 401);
  assert.equal((await handler.fetch(tick('a', 'a', 'another-project'))).status, 403);
  assert.equal(opened, 0);
});
for (const deliveryFails of [false, true])
  test(`scheduled monitoring persists measurements and reports delivery failure=${deliveryFails}`, async () => {
    const db = createDb(':memory:');
    let down = true,
      sends = 0;
    const handler = createScheduledHandler({
      open: async () => db,
      configuration: () => config,
      check: async () => ({
        ok: !down,
        statusCode: down ? 503 : 200,
        responseMs: 12,
        error: down ? 'http_503' : null,
      }),
      send: async () => {
        sends++;
        if (deliveryFails) throw Object.assign(Error('fixture'), { code: 'http_error' });
      },
    });
    try {
      assert.equal((await handler.fetch(tick())).status, 200);
      const second = await handler.fetch(tick());
      assert.equal(second.status, deliveryFails ? 503 : 200);
      assert.equal(sends, 4);
      assert.equal(db.prepare('SELECT count(*) n FROM checks').get().n, 8);
      assert.equal(
        db.prepare("SELECT count(*) n FROM incidents WHERE status!='resolved'").get().n,
        4,
      );
      const events = db.prepare('SELECT * FROM notification_outbox').all();
      assert.ok(
        events.every((row) => row.attempts === 1 && Boolean(row.delivered_at) === !deliveryFails),
      );
      down = false;
      const recovered = await handler.fetch(tick());
      assert.equal(recovered.status, deliveryFails ? 503 : 200);
      assert.equal(
        db.prepare("SELECT count(*) n FROM incidents WHERE status!='resolved'").get().n,
        0,
      );
      assert.equal(db.prepare('SELECT count(*) n FROM notification_outbox').get().n, 8);
    } finally {
      db.close();
    }
  });
