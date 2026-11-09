import { parseTriggerDelivery } from '@neon/functions/triggers';
import { createPostgresDb } from './postgres.js';
import { webhookConfig, runNotificationBatch } from './notifications.js';
import { monitorRunner, probe } from './monitoring.js';

let database;
function openDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('Configure the persistent database');
  const connection = new URL(process.env.DATABASE_URL);
  connection.searchParams.set('sslmode', 'verify-full');
  database ??= createPostgresDb(connection.toString(), {
    initialize: false,
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

export function createScheduledHandler({
  open = openDatabase,
  configuration = () => webhookConfig(),
  send,
  check = probe,
} = {}) {
  return {
    async fetch(request) {
      if (new URL(request.url).pathname !== '/cron')
        return new Response('Not found', { status: 404 });
      if (request.method !== 'POST')
        return new Response('Method not allowed', {
          status: 405,
          headers: { Allow: 'POST' },
        });
      const parsed = await parseTriggerDelivery(request);
      if (!parsed.ok)
        return new Response('Unauthorized', {
          status: parsed.error === 'invalid_body' ? 400 : 401,
        });
      if (
        parsed.invocation.type !== 'schedule' ||
        parsed.invocation.trigger.name !== 'pulsewatch-monitoring'
      )
        return new Response('Unexpected trigger', { status: 403 });
      try {
        const config = configuration();
        if (!config) throw new Error('Configure external delivery');
        const db = await open();
        const runner = monitorRunner(db, { check });
        let completed;
        try {
          completed = await runner.run();
        } finally {
          await runner.stop();
        }
        const summary = {
          monitoring: completed ? 'completed' : 'leased',
          ...(await runNotificationBatch(db, { config, ...(send ? { send } : {}) })),
        };
        console.log(JSON.stringify({ event: 'monitoring_batch', ...summary }));
        return Response.json(summary, { status: summary.failed ? 503 : 200 });
      } catch {
        console.error(
          JSON.stringify({
            event: 'monitoring_batch',
            status: 'unavailable',
          }),
        );
        return Response.json({ status: 'unavailable' }, { status: 503 });
      }
    },
  };
}

export default createScheduledHandler();
