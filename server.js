import { notificationRunner, webhookConfig } from './notifications.js';
import { operatorBoundary } from './request-policy.js';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { targetUrl, monitorRunner, defaultHosts } from './monitoring.js';
const root = dirname(fileURLToPath(import.meta.url));
export function createDb(file = resolve(root, 'data', 'pulsewatch.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    db.exec('BEGIN IMMEDIATE');
    db.exec(
      `CREATE TABLE IF NOT EXISTS monitors(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,url TEXT,status TEXT,response_ms INTEGER,uptime REAL,last_checked TEXT);CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,detail TEXT,severity TEXT,status TEXT,started_at TEXT,resolved_at TEXT);`,
    );
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(monitors)')
        .all()
        .map((c) => c.name),
    );
    if (!columns.has('enabled'))
      db.exec(
        "ALTER TABLE monitors ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0; ALTER TABLE monitors ADD COLUMN status_source TEXT NOT NULL DEFAULT 'manual';",
      );
    if (
      !db
        .prepare('PRAGMA table_info(incidents)')
        .all()
        .some((c) => c.name === 'monitor_id')
    )
      db.exec('ALTER TABLE incidents ADD COLUMN monitor_id INTEGER REFERENCES monitors(id);');
    db.exec(
      `CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY AUTOINCREMENT,monitor_id INTEGER NOT NULL REFERENCES monitors(id),checked_at TEXT NOT NULL,ok INTEGER NOT NULL CHECK(ok IN (0,1)),status_code INTEGER,response_ms INTEGER,error TEXT);CREATE INDEX IF NOT EXISTS checks_monitor_time ON checks(monitor_id,checked_at DESC,id DESC);CREATE UNIQUE INDEX IF NOT EXISTS incidents_monitor_open ON incidents(monitor_id) WHERE monitor_id IS NOT NULL AND status!='resolved';PRAGMA user_version=1;`,
    );
    if (!db.prepare('SELECT COUNT(*) n FROM monitors').get().n) {
      const add = db.prepare(
        "INSERT INTO monitors(name,url,status,response_ms,uptime,last_checked,enabled,status_source) VALUES(?,?,'unknown',NULL,NULL,NULL,1,'probe')",
      );
      for (const [name, url] of [
        ['Flowboard', 'https://' + defaultHosts[0] + '/flowboard-project-manager/'],
        ['Seatly', 'https://' + defaultHosts[0] + '/seatly-workspace-booking/'],
        ['Flowboard API', 'https://' + defaultHosts[1] + '/api/health'],
        ['Seatly API', 'https://' + defaultHosts[1] + '/api/seatly/health'],
      ])
        add.run(name, url);
    }
    db.exec(readFileSync(new URL('./notifications.sql', import.meta.url), 'utf8'));
    db.exec('PRAGMA user_version=2');
    db.exec('COMMIT');
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}
const monitorSchema = z
  .object({ name: z.string().trim().min(2).max(80), url: z.string().trim().min(4).max(1000) })
  .strict();
export function createApp(db = createDb(), { runner = monitorRunner(db) } = {}) {
  const app = express();
  app.use(operatorBoundary());
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', monitoring: runner.running ? 'checking' : 'idle' }),
  );
  app.get('/api/overview', (_req, res) => {
    const monitors = db
      .prepare(
        `SELECT m.id,m.name,m.url,m.enabled,m.status_source,CASE WHEN m.status_source='probe' AND m.last_checked IS NOT NULL THEN m.status ELSE 'unknown' END status,CASE WHEN m.status_source='probe' THEN m.response_ms ELSE NULL END response_ms,CASE WHEN m.status_source='probe' THEN m.last_checked ELSE NULL END last_checked,(SELECT ROUND(100.0*SUM(ok)/COUNT(*),2) FROM checks WHERE monitor_id=m.id) uptime,(SELECT COUNT(*) FROM checks WHERE monitor_id=m.id) check_count FROM monitors m ORDER BY m.id`,
      )
      .all();
    const incidents = db
      .prepare('SELECT * FROM incidents ORDER BY started_at DESC LIMIT 100')
      .all();
    const history = db
      .prepare(
        'SELECT MAX(checked_at) checked_at,ROUND(AVG(response_ms)) response_ms FROM checks WHERE checked_at>=? GROUP BY substr(checked_at,1,16) ORDER BY checked_at DESC LIMIT 60',
      )
      .all(new Date(Date.now() - 12 * 3600000).toISOString())
      .reverse();
    const observed = monitors.filter((m) => m.enabled && m.last_checked),
      overall = observed.some((m) => m.status === 'down')
        ? 'down'
        : observed.some((m) => m.status === 'degraded')
          ? 'degraded'
          : observed.length
            ? 'operational'
            : 'unknown';
    res.json({ overall, monitors, incidents, history });
  });
  app.post('/api/monitors', (req, res) => {
    const parsed = monitorSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: 'Проверьте название и HTTPS-адрес' });
    let url;
    try {
      url = targetUrl(parsed.data.url).href;
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }
    if (db.prepare('SELECT COUNT(*) n FROM monitors').get().n >= 30)
      return res.status(409).json({ message: 'Доступно до 30 целей мониторинга' });
    if (db.prepare('SELECT id FROM monitors WHERE url=? AND enabled=1').get(url))
      return res.status(409).json({ message: 'Эта цель уже добавлена' });
    const result = db
      .prepare(
        "INSERT INTO monitors(name,url,status,enabled,status_source) VALUES(?,?,'unknown',1,'probe')",
      )
      .run(parsed.data.name, url);
    res.status(201).json({ id: Number(result.lastInsertRowid), ...parsed.data, url });
  });
  let lastManual = 0;
  app.post('/api/check', (_req, res) => {
    if (runner.running) return res.status(202).json({ status: 'running' });
    if (Date.now() - lastManual < 15000)
      return res.status(429).json({ message: 'Следующая проверка доступна через 15 секунд' });
    lastManual = Date.now();
    void runner
      .run()
      .catch(() =>
        console.error(JSON.stringify({ event: 'manual_monitor_cycle', status: 'failed' })),
      );
    res.status(202).json({ status: 'started' });
  });
  // Retained for API compatibility: manual values never become measured history or availability statistics.
  app.patch('/api/monitors/:id', (req, res) => {
    const p = z
      .object({
        status: z.enum(['operational', 'degraded', 'down']),
        responseMs: z.number().int().nonnegative(),
      })
      .strict()
      .safeParse(req.body);
    if (!p.success) return res.status(400).json({ message: 'Неверные данные проверки' });
    const out = db
      .prepare(
        "UPDATE monitors SET status=?,response_ms=?,status_source='manual',enabled=0 WHERE id=?",
      )
      .run(p.data.status, p.data.responseMs, Number(req.params.id));
    return out.changes
      ? res.json({ ok: true })
      : res.status(404).json({ message: 'Монитор не найден' });
  });
  app.patch('/api/monitors/:id/enabled', (req, res) => {
    const p = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!p.success) return res.status(400).json({ message: 'Укажите enabled' });
    const m = db.prepare('SELECT url FROM monitors WHERE id=?').get(Number(req.params.id));
    if (!m) return res.status(404).json({ message: 'Монитор не найден' });
    if (p.data.enabled) {
      try {
        targetUrl(m.url);
      } catch {
        return res.status(400).json({ message: 'Домен должен быть разрешён владельцем сервера' });
      }
    }
    db.prepare('UPDATE monitors SET enabled=? WHERE id=?').run(
      Number(p.data.enabled),
      Number(req.params.id),
    );
    res.json({ ok: true });
  });
  app.post('/api/incidents', (req, res) => {
    const p = z
      .object({
        title: z.string().trim().min(4).max(160),
        detail: z.string().min(8).max(1000),
        severity: z.enum(['minor', 'major', 'critical']),
      })
      .strict()
      .safeParse(req.body);
    if (!p.success) return res.status(400).json({ message: 'Заполните данные инцидента' });
    const result = db
      .prepare(
        "INSERT INTO incidents(title,detail,severity,status,started_at) VALUES(?,?,?,'investigating',?)",
      )
      .run(p.data.title, p.data.detail, p.data.severity, new Date().toISOString());
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });
  app.patch('/api/incidents/:id/resolve', (req, res) => {
    const result = db
      .prepare(
        "UPDATE incidents SET status='resolved',resolved_at=? WHERE id=? AND status!='resolved'",
      )
      .run(new Date().toISOString(), Number(req.params.id));
    return result.changes ||
      db.prepare('SELECT id FROM incidents WHERE id=?').get(Number(req.params.id))
      ? res.json({ ok: true })
      : res.status(404).json({ message: 'Инцидент не найден' });
  });
  app.use(express.static(resolve(root, 'public')));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(resolve(root, 'public', 'index.html')));
  app.use((error, _req, res, _next) => {
    const status =
      error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 503;
    if (status === 503) console.error({ event: 'request_error', error: String(error) });
    res.status(status).json({ message: 'Не удалось обработать запрос' });
  });
  return app;
}
if (process.env.NODE_ENV !== 'test') {
  const configuration = webhookConfig();
  const db = createDb(),
    notifications = notificationRunner(db, { config: configuration }),
    runner = monitorRunner(db, {
      intervalMs: Number(process.env.MONITOR_INTERVAL_SECONDS || 60) * 1000,
      retentionDays: Number(process.env.MONITOR_RETENTION_DAYS || 30),
    }),
    server = createApp(db, { runner }).listen(Number(process.env.PORT || 4400), '127.0.0.1', () => {
      console.log('Pulsewatch: http://localhost:' + Number(process.env.PORT || 4400));
      if (process.env.MONITOR_ENABLED !== 'false') runner.start();
      notifications.start();
    });
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await Promise.all([
        runner.stop(),
        notifications.stop(),
        new Promise((resolve) => server.close(resolve)),
      ]);
      db.close();
    });
}
