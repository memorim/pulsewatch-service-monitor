# Live PostgreSQL, scheduled monitoring and restart verification — 2026-11-09

Render Free deployment `dep-dbos9dvb9u1s73e1dkog` reached live at 13:04:27 UTC from source `4391522f02af237ee94a835a305686a210e989f1`. It uses a separate Neon Free PostgreSQL project; continuous monitoring/notification loops are disabled and the Render health check remains TCP. No paid disk, cron or worker was created.

The scheduled Function recorded real probes at 13:05, 13:06 and 13:07 UTC. The two GitHub Pages targets returned HTTP 200. Both legacy API targets on the configured chatgpt.site hostname failed with network_error; these remain real open incidents and were not relabeled healthy. At 13:06:02 UTC the Function reported attempted=2, delivered=2, failed=0. The ntfy provider accepted both incident events; operator-device receipt is not confirmed. The enabled schedule was restored to `*/15 * * * *` after validation.

Manual same-source redeployment `dep-dbosbggu01pc73896n7g` reached live at 13:08:53 UTC. PostgreSQL fingerprints before and after were identical:

| Data | MD5 of ordered JSON rows |
| --- | --- |
| monitors | 60d1461f6b70f986cfa32ba8f0fe86e1 |
| checks | 20e94ec5f999eb967fa9d7341d17afdf |
| incidents | 6044bc805b88de64653f57ffea5e30ef |
| notification outbox | 054341d05e8343a36eb9034bcdc95b2f |

This confirms application-restart persistence of live measurements, incident state and acknowledged notifications. It does not test independent backup recovery or a human operator's device.

CI run 42621969329 passed quality, real PostgreSQL integration, historical SQLite upgrades, browser demo and desktop/mobile browser checks. The scheduled bundle rejects anonymous invocations; integration tests cover multiple database connections, atomic incident events, cycle leases, delivery leases/retries and reopening. HTTPS operator access retains its existing Basic credential and origin protection.
