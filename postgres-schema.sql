CREATE TABLE monitors (
 id BIGSERIAL PRIMARY KEY, name TEXT, url TEXT, status TEXT,
 response_ms INTEGER, uptime DOUBLE PRECISION, last_checked TEXT,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 status_source TEXT NOT NULL DEFAULT 'manual'
);
CREATE TABLE incidents (
 id BIGSERIAL PRIMARY KEY, title TEXT, detail TEXT, severity TEXT, status TEXT,
 started_at TEXT, resolved_at TEXT, monitor_id BIGINT REFERENCES monitors(id)
);
CREATE TABLE checks (
 id BIGSERIAL PRIMARY KEY, monitor_id BIGINT NOT NULL REFERENCES monitors(id),
 checked_at TEXT NOT NULL, ok INTEGER NOT NULL CHECK(ok IN (0,1)),
 status_code INTEGER, response_ms INTEGER, error TEXT
);
CREATE INDEX checks_monitor_time ON checks(monitor_id,checked_at DESC,id DESC);
CREATE UNIQUE INDEX incidents_monitor_open ON incidents(monitor_id)
 WHERE monitor_id IS NOT NULL AND status!='resolved';
CREATE TABLE notification_outbox (
 id BIGSERIAL PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
 payload TEXT NOT NULL, created_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 next_attempt_at BIGINT NOT NULL DEFAULT 0,
 lease_until BIGINT NOT NULL DEFAULT 0, lease_token TEXT,
 delivered_at TEXT, failed_at TEXT,
 last_error TEXT CHECK(last_error IN ('network_error','http_error','shutdown') OR last_error IS NULL)
);
CREATE INDEX notifications_due ON notification_outbox(delivered_at,failed_at,next_attempt_at,lease_until);
CREATE TABLE cycle_leases (
 name TEXT PRIMARY KEY, token TEXT NOT NULL, lease_until BIGINT NOT NULL
);
