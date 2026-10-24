# Пример API

Новая база до первых измерений.

```http
GET /api/overview
```

```json
{
  "overall": "unknown",
  "monitors": [
    {
      "id": 1,
      "name": "Flowboard",
      "url": "https://memorim.github.io/flowboard-project-manager/",
      "enabled": 1,
      "status_source": "probe",
      "status": "unknown",
      "response_ms": null,
      "last_checked": null,
      "uptime": null,
      "check_count": 0
    },
    {
      "id": 2,
      "name": "Seatly",
      "url": "https://memorim.github.io/seatly-workspace-booking/",
      "enabled": 1,
      "status_source": "probe",
      "status": "unknown",
      "response_ms": null,
      "last_checked": null,
      "uptime": null,
      "check_count": 0
    },
    {
      "id": 3,
      "name": "Flowboard API",
      "url": "https://memorim-flowboard-live.amusedcorgi34.chatgpt.site/api/health",
      "enabled": 1,
      "status_source": "probe",
      "status": "unknown",
      "response_ms": null,
      "last_checked": null,
      "uptime": null,
      "check_count": 0
    },
    {
      "id": 4,
      "name": "Seatly API",
      "url": "https://memorim-flowboard-live.amusedcorgi34.chatgpt.site/api/seatly/health",
      "enabled": 1,
      "status_source": "probe",
      "status": "unknown",
      "response_ms": null,
      "last_checked": null,
      "uptime": null,
      "check_count": 0
    }
  ],
  "incidents": [],
  "history": []
}
```
