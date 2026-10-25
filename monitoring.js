import { allowedHosts, targetUrl } from './network-policy.js';
import { pinnedRequest } from './transport.js';
export { allowedHosts, targetUrl, publicAddress, defaultHosts } from './network-policy.js';

export async function probe(
  value,
  { hosts = allowedHosts(), resolve, request, signal = new AbortController().signal } = {},
) {
  let url = targetUrl(value, hosts);
  const started = performance.now();
  signal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await pinnedRequest(url, { resolve, request, signal });
    if (response.code >= 300 && response.code < 400 && response.location) {
      const next = targetUrl(new URL(response.location, url).href, hosts);
      if (url.protocol === 'https:' && next.protocol !== 'https:')
        throw new Error('insecure_redirect');
      url = next;
      continue;
    }
    return {
      ok: response.code >= 200 && response.code < 400,
      statusCode: response.code,
      responseMs: Math.round(performance.now() - started),
      error: response.code >= 400 ? 'http_' + response.code : null,
    };
  }
  throw new Error('redirect_limit');
}
export async function checkMonitor(
  db,
  monitor,
  { check = probe, now = new Date().toISOString(), signal } = {},
) {
  let result;
  try {
    result = await check(monitor.url, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    result = {
      ok: false,
      statusCode: null,
      responseMs: null,
      error: error?.message === 'non_public_address' ? 'non_public_address' : 'network_error',
    };
  }
  const state = result.ok ? (result.responseMs > 1000 ? 'degraded' : 'operational') : 'down';
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT enabled,url FROM monitors WHERE id=?').get(monitor.id);
    if (!current?.enabled || current.url !== monitor.url) {
      db.exec('ROLLBACK');
      return result;
    }
    db.prepare(
      'INSERT INTO checks(monitor_id,checked_at,ok,status_code,response_ms,error) VALUES(?,?,?,?,?,?)',
    ).run(monitor.id, now, Number(result.ok), result.statusCode, result.responseMs, result.error);
    db.prepare(
      "UPDATE monitors SET status=?,response_ms=?,last_checked=?,status_source='probe' WHERE id=?",
    ).run(state, result.responseMs, now, monitor.id);
    const recent = db
      .prepare('SELECT ok FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 2')
      .all(monitor.id);
    if (!result.ok && recent.length === 2 && recent.every((r) => !r.ok))
      db.prepare(
        "INSERT INTO incidents(title,detail,severity,status,started_at,monitor_id) SELECT ?,?,'major','investigating',?,? WHERE NOT EXISTS(SELECT 1 FROM incidents WHERE monitor_id=? AND status!='resolved')",
      ).run(
        'Сервис недоступен: ' + monitor.name,
        'Две последовательные проверки завершились ошибкой.',
        now,
        monitor.id,
        monitor.id,
      );
    if (result.ok)
      db.prepare(
        "UPDATE incidents SET status='resolved',resolved_at=? WHERE monitor_id=? AND status!='resolved'",
      ).run(now, monitor.id);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return result;
}
export function monitorRunner(db, { check = probe, intervalMs = 60000, retentionDays = 30 } = {}) {
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs < 5000 ||
    intervalMs > 86400000 ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 365
  )
    throw new Error('Invalid monitoring schedule');
  let running = false,
    stopped = false,
    started = false,
    timer,
    active = Promise.resolve(false);
  const controller = new AbortController();
  const run = () => {
    if (running || stopped) return Promise.resolve(false);
    running = true;
    active = (async () => {
      try {
        // ponytail: sequential probes bound outbound concurrency to one; use a bounded pool if target count grows beyond 30.
        for (const monitor of db
          .prepare('SELECT * FROM monitors WHERE enabled=1 ORDER BY id')
          .all()) {
          if (stopped) break;
          await checkMonitor(db, monitor, { check, signal: controller.signal });
        }
        db.prepare('DELETE FROM checks WHERE checked_at<?').run(
          new Date(Date.now() - retentionDays * 86400000).toISOString(),
        );
        return true;
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        return false;
      } finally {
        running = false;
      }
    })();
    return active;
  };
  const start = () => {
    if (started || stopped) return;
    started = true;
    const tick = async () => {
      try {
        await run();
      } catch {
        console.error(JSON.stringify({ event: 'monitor_cycle', status: 'failed' }));
      }
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        timer.unref();
      }
    };
    void tick();
  };
  return {
    run,
    start,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      await active;
    },
    get running() {
      return running;
    },
  };
}
