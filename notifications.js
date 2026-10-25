import { randomUUID } from 'node:crypto';
import { targetUrl } from './network-policy.js';
import { pinnedRequest } from './transport.js';

export function webhookConfig(env = process.env) {
  if (!env.MONITOR_WEBHOOK_URL) return null;
  const parsed = new URL(env.MONITOR_WEBHOOK_URL);
  const url = targetUrl(parsed.href, new Set([parsed.hostname]));
  if (url.protocol !== 'https:') throw new Error('Webhook requires HTTPS');
  const token = env.MONITOR_WEBHOOK_TOKEN || '';
  if (token.length > 2048 || /[\r\n]/.test(token)) throw new Error('Invalid webhook credential');
  return { url, token };
}

export async function sendWebhook(config, row, options = {}) {
  if (Buffer.byteLength(row.payload) > 4096) throw new Error('payload_limit');
  const response = await pinnedRequest(config.url, {
    ...options,
    method: 'POST',
    body: row.payload,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(row.payload)),
      'Idempotency-Key': row.event_key,
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
  });
  // A redirect never receives the token or payload. Receivers should deduplicate by Idempotency-Key.
  if (response.code < 200 || response.code >= 300) {
    const error = new Error('Webhook returned a non-success status');
    error.code = 'http_error';
    throw error;
  }
}

// ponytail: one dispatcher per process; SQLite claims/leases also tolerate a restarted or second dispatcher.
export function notificationRunner(
  db,
  { config = webhookConfig(), send = sendWebhook, clock = Date.now, log = console.error } = {},
) {
  let active,
    stopped = false,
    started = false,
    timer;
  const controller = new AbortController();
  function claim() {
    const now = clock();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'UPDATE notification_outbox SET failed_at=?,last_error=COALESCE(last_error,?) WHERE attempts>=5 AND delivered_at IS NULL AND failed_at IS NULL AND lease_until<=?',
      ).run(new Date(now).toISOString(), 'network_error', now);
      const row = db
        .prepare(
          'SELECT * FROM notification_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND attempts<5 AND next_attempt_at<=? AND lease_until<=? ORDER BY id LIMIT 1',
        )
        .get(now, now);
      if (row) {
        row.lease_token = randomUUID();
        row.attempts++;
        db.prepare(
          'UPDATE notification_outbox SET attempts=?,lease_until=?,lease_token=? WHERE id=?',
        ).run(row.attempts, now + 20000, row.lease_token, row.id);
      }
      db.exec('COMMIT');
      return row;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  function run() {
    if (!config || stopped || active) return Promise.resolve(false);
    active = (async () => {
      for (let count = 0; count < 10 && !stopped; count++) {
        const row = claim();
        if (!row) break;
        try {
          await send(config, row, { signal: controller.signal });
          db.prepare(
            'UPDATE notification_outbox SET delivered_at=?,lease_until=0,lease_token=NULL,last_error=NULL WHERE id=? AND lease_token=?',
          ).run(new Date(clock()).toISOString(), row.id, row.lease_token);
        } catch (error) {
          const code = controller.signal.aborted
            ? 'shutdown'
            : error?.code === 'http_error'
              ? 'http_error'
              : 'network_error';
          db.prepare(
            'UPDATE notification_outbox SET next_attempt_at=?,lease_until=0,lease_token=NULL,last_error=?,failed_at=? WHERE id=? AND lease_token=?',
          ).run(
            clock() + Math.min(300000, 5000 * 2 ** (row.attempts - 1)),
            code,
            row.attempts >= 5 ? new Date(clock()).toISOString() : null,
            row.id,
            row.lease_token,
          );
          // Fixed metadata only: no URL, token, response body or arbitrary exception message.
          log(
            JSON.stringify({
              event: 'notification_attempt',
              id: row.id,
              attempt: row.attempts,
              error: code,
            }),
          );
        }
      }
      return true;
    })().finally(() => {
      active = undefined;
    });
    return active;
  }
  return {
    run,
    start() {
      if (started || stopped || !config) return;
      started = true;
      const tick = async () => {
        try {
          await run();
        } catch {
          log(JSON.stringify({ event: 'notification_cycle', status: 'failed' }));
        }
        if (!stopped) {
          timer = setTimeout(tick, 5000);
          timer.unref();
        }
      };
      void tick();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      await active;
    },
    get enabled() {
      return Boolean(config);
    },
  };
}
