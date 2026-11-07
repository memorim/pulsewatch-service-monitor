# Persistent storage and public operator checks

Set `PULSEWATCH_DATA_DIRECTORY` to a mounted persistent disk. Its `pulsewatch.db`
contains monitors, checks, incidents, notification leases, attempts and delivery
records. Omitting the setting keeps the existing `data/` path. Public static
directories are rejected. Stop writes and back up the old database consistently
before copying it; preserve the original until restore and restart checks pass.
Setting a path alone does not provision a persistent disk.

The server supports `HOST=0.0.0.0` behind a TLS proxy, provided
`APP_PUBLIC_ORIGIN` and `APP_OPERATOR_TOKEN` are configured. Without public mode,
an external bind fails at startup. Public mode still validates HTTPS, token
length, Host and Origin before serving the operator interface or API.

Run `pnpm smoke` with `SMOKE_URL=https://your-service`, `SMOKE_USER=operator`
and `SMOKE_PASSWORD` set privately to the operator token. Credentials are never
logged, URL credentials and redirects are rejected, and plain HTTP credentials
are accepted only on loopback for testing. `EXPECTED_REVISION` optionally checks
the source SHA supplied to the release. Hosted health checks also need operator
authentication; do not expose a public bypass to satisfy a hosting probe.

Local tests cover process restart persistence, public-path rejection, unsafe
binds and authenticated health checks. A real webhook recipient, persistent disk,
HTTPS edge, restart and successful notification delivery remain deployment
checks; local fixtures do not establish those external results.
