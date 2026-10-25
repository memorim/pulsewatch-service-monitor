CREATE TABLE IF NOT EXISTS notification_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 event_key TEXT NOT NULL UNIQUE,
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 delivered_at TEXT,
 failed_at TEXT,
 last_error TEXT CHECK(last_error IN ('network_error','http_error','shutdown') OR last_error IS NULL)
);
CREATE INDEX IF NOT EXISTS notifications_due ON notification_outbox(delivered_at,failed_at,next_attempt_at,lease_until);
CREATE TRIGGER IF NOT EXISTS incident_open_notification AFTER INSERT ON incidents
WHEN NEW.status != 'resolved'
BEGIN
 INSERT INTO notification_outbox(event_key,payload,created_at)
 VALUES('incident:'||NEW.id||':opened',json_object('event','incident.opened','incidentId',NEW.id,'monitorId',NEW.monitor_id,'title',NEW.title,'severity',NEW.severity,'at',NEW.started_at),NEW.started_at);
END;
CREATE TRIGGER IF NOT EXISTS incident_close_notification AFTER UPDATE OF status ON incidents
WHEN OLD.status != 'resolved' AND NEW.status = 'resolved'
BEGIN
 INSERT OR IGNORE INTO notification_outbox(event_key,payload,created_at)
 VALUES('incident:'||NEW.id||':closed',json_object('event','incident.closed','incidentId',NEW.id,'monitorId',NEW.monitor_id,'title',NEW.title,'severity',NEW.severity,'at',NEW.resolved_at),NEW.resolved_at);
END;
