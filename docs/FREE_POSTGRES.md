# Persistent PostgreSQL without a Render disk

Set `DATABASE_URL` to a separate Neon Free database. Remote connections require
`sslmode=verify-full`; certificate verification cannot be disabled. Without the
variable, local SQLite and its existing upgrade path remain available.

The application initializes a checksummed `pulsewatch` schema under a transaction
and advisory lock. It verifies the seeded monitors, incidents, measurements and
outbox before installing atomic incident triggers. It does not import a previous
Render disk automatically: back up and explicitly migrate any non-demo SQLite
data before changing storage. The current deployment has only demo records.

With PostgreSQL, continuous monitoring and notification polling default to off.
Use a scheduled worker; explicitly opting into `MONITOR_ENABLED=true` or
`MONITOR_NOTIFICATIONS_ENABLED=true` can keep database compute awake and exhaust
free allowances. Keep Render's TCP health check; continuous HTTP readiness polling
would also keep the database awake. `/api/health` tests actual database readiness
and retains operator authentication.

Transactions serialize incident state with its outbox, and a five-minute database
lease prevents overlapping monitoring cycles across processes. Each cycle checks
at most the application's 30 configured targets with bounded concurrency and
existing verified TLS, public-address DNS pinning and redirect rules. A crashed
lease expires. A lost provider acknowledgement may still duplicate a push; event
keys remain stable. Certificate verification, operator authentication and origin
checks remain required.

CI uses a disposable PostgreSQL 16 service to check measured ratios, atomic
open/close notifications, multiple processes, cycle leases, delivery retries and
reopening. This verifies application persistence, not an independent backup.
