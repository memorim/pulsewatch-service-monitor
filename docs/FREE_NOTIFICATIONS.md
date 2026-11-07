# Free ntfy push notifications

Set `NTFY_TOPIC` to a random 32–128 character string in the server environment
and remove `MONITOR_WEBHOOK_URL` to select ntfy instead of a generic webhook.
Generate a topic with `openssl rand -hex 24`; keep it outside Git. Subscribe
at `https://ntfy.sh/<your-topic>` in the browser or ntfy mobile app.

The existing durable delivery queue publishes only the project name and event
key. Incident descriptions, target URLs and credentials are excluded. Public
DNS validation, IP pinning, HTTPS, bounded requests, five attempts, lease
recovery and manual retry remain in force. ntfy can deliver a duplicate after
a lost acknowledgement; it does not implement this application's deduplication.

Anonymous ntfy.sh currently permits 250 messages per visitor/day free of charge.
Free topics are unlisted public channels, not authenticated private storage.
Use an unpredictable topic and generic messages. Quota and service availability
can delay notifications; the operator dashboard remains authoritative. This
code change alone does not configure or deploy a production receiver.

Provider documentation: https://docs.ntfy.sh/publish/ and https://docs.ntfy.sh/privacy/.
