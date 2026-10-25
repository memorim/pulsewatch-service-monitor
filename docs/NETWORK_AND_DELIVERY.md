# Network and incident delivery

## Modules and boundaries

- `network-policy.js`: operator hostname allowlist, URL canonicalization and conservative public-IP policy.
- `transport.js`: bounded resolution, validated address pinning and header-only HTTP transport with cancellation. No shared connection pool can bypass a fresh DNS check.
- `monitoring.js`: redirect policy, check persistence, two-failure incident transitions and sequential scheduling.
- `notifications.sql`: outbox events in the same transaction as incident changes.
- `notifications.js`: operator-only webhook configuration, fenced delivery claims and limited retries.

The policy rejects private/loopback/link-local/metadata, multicast, documentation, transition and reserved ranges. IPv6 is canonicalized before checking. Mixed public/private DNS answers, empty answers and inconsistent address families fail closed. Only exact configured hostnames are allowed for probes; webhook destination is separately operator-configured, HTTPS-only and standard-port. Neither accepts credentials/query/fragment URLs. Redirects revalidate target/DNS and cannot downgrade HTTPS. Webhooks reject all redirects, keeping their bearer token on the single configured host.

Reference lists: [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry) and [IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry), reviewed 2026-10-25. This is deliberately stricter than a general Internet router: some globally reachable special ranges are denied too. Address lists need periodic maintenance. Public IP checks cannot detect an operator network that routes public address space internally; enforce egress/network isolation as well. Monitoring plain HTTP can observe untrusted network responses; HTTPS verifies normal certificates.

## Timing and metrics

One monitoring cycle and one probe are active per process. The next cycle starts after the configured 5-second to 24-hour delay following the previous cycle. DNS timeout: 5 seconds; HTTP header timeout: 8 seconds; total redirect-chain deadline: 20 seconds. At most three redirects are followed. Headers are bounded to 16 KiB; bodies are immediately destroyed, not accumulated. A long cycle can therefore extend the effective sampling interval. Run one scheduler process per database; there is no multi-node probe lease.

The dashboard uses successful retained observations / all retained observations. The retention window is configurable, 1–365 days. This is **check success rate**, not time-weighted uptime/SLA, and a gap between samples is not invented availability. Latency measures time to response headers. The legacy API field `uptime` is retained.

## Durable webhook contract

Set `MONITOR_WEBHOOK_URL` and optionally `MONITOR_WEBHOOK_TOKEN` as environment secrets. Do not put real credentials in the repository. The destination receives JSON `{event, incidentId, monitorId, title, severity, at}` and `Idempotency-Key: incident:<id>:opened|closed`. Treat the receiver as trusted for incident titles. No external receiver is configured by default.

A SQLite trigger inserts each event with the incident transaction. A dispatcher claims at most 10 due events per run and sends them sequentially, every 5 seconds after completion. A claim has a 20-second lease and random fencing token. The network stages are bounded within that lease. Failures retry after 5, 10, 20, 40 or 80 seconds, with a hard total of five attempts including interrupted/crashed attempts. An expired fifth lease becomes failed; earlier leases can be reclaimed after restart. Delivery state is saved only if the claim token still matches.

A crash after receiver acceptance and before the local acknowledgment can duplicate a message; receiver deduplication is required. Success is any 2xx; redirects/other statuses fail without following Location. Arbitrary response bodies and exception messages never enter notification logs. Shutdown aborts and awaits the active request before closing the database. Pending events remain durable. Delivered/failed records are retained for diagnosis; archival and manual retry decisions are operator responsibilities.

Tests use in-memory/temporary databases, mock resolvers and a local HTTP receiver behind a test-only request adapter. No production DNS/TLS bypass switch is exposed in configuration. `pnpm test` runs these checks without calling public endpoints.
