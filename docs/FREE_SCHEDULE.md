# Scheduled monitoring on the free plan

Build with `pnpm build:monitoring`, deploy `.neon-build/monitoring.zip` as a Neon
Function (`nodejs24`) on the same branch as PostgreSQL, and configure `NTFY_TOPIC`
as a random 32–128 character subscription secret. `DATABASE_URL` is injected by
Neon; the handler enforces verified TLS and refuses to create or migrate a schema.
Start the web application once to initialize PostgreSQL before enabling it.

Create a schedule trigger named `pulsewatch-monitoring`, targeting `/cron`, every
15 minutes (`*/15 * * * *`). `deploy/monitoring.json` records the intended setup.
The official trigger parser validates the platform invocation before database or
network work. Ordinary anonymous HTTP requests cannot start a cycle.

The Function performs the existing real HTTP probes and drains up to ten due
notifications. Non-success delivery or a lost lease produces HTTP 503 and a failed
batch log; the durable queue retains retry state. No paid Render worker, cron job
or disk is needed. A 15-minute cadence allows Neon Free compute to suspend between
cycles; continuous minute-level polling can exhaust its allowance. Keep continuous
Render monitoring and notification loops disabled.

This cadence detects a two-probe outage after roughly 15–30 minutes, plus execution
delay. It is not a one-minute monitor or an SLA guarantee. Free storage, compute,
Functions and ntfy limits still apply; a full quota can pause checks or delivery.
The ntfy subscription topic is an unlisted shared secret, not an authenticated
private channel. Only generic project/event identifiers are sent. Provider
acceptance does not confirm receipt on the operator's device.

The operator UI and API remain protected by HTTPS plus the configured Basic
credential. PostgreSQL persistence does not replace an independent backup.

References: https://neon.com/docs/functions/function-triggers and
https://neon.com/docs/introduction/pro-plan and https://docs.ntfy.sh/publish/.
