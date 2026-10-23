# Пример API

Ответ получен при локальном запуске проверяемой версии. Данные демонстрационные.

```http
GET /api/overview HTTP/1.1
Host: localhost:4400
```

HTTP 200

```json
{
  "overall": "degraded",
  "monitors": [
    {
      "id": 1,
      "name": "Public API",
      "url": "api.northstar.dev",
      "status": "operational",
      "response_ms": 128,
      "uptime": 99.99,
      "last_checked": "2026-07-04T10:58:00"
    },
    {
      "id": 2,
      "name": "Web application",
      "url": "app.northstar.dev",
      "status": "operational",
      "response_ms": 242,
      "uptime": 99.97,
      "last_checked": "2026-07-04T10:58:00"
    },
    {
      "id": 3,
      "name": "Authentication",
      "url": "auth.northstar.dev",
      "status": "degraded",
      "response_ms": 684,
      "uptime": 99.82,
      "last_checked": "2026-07-04T10:57:00"
    },
    {
      "id": 4,
      "name": "File storage",
      "url": "cdn.northstar.dev",
      "status": "operational",
      "response_ms": 96,
      "uptime": 100,
      "last_checked": "2026-07-04T10:58:00"
    }
  ],
  "incidents": [
    {
      "id": 1,
      "title": "Повышенная задержка авторизации",
      "detail": "Часть запросов OAuth обрабатывается медленнее обычного. Команда масштабирует пул соединений.",
      "severity": "minor",
      "status": "investigating",
      "started_at": "2026-07-04T09:42:00",
      "resolved_at": null
    },
    {
      "id": 2,
      "title": "Кратковременная недоступность API",
      "detail": "Сервис восстановлен, потерянных данных нет.",
      "severity": "major",
      "status": "resolved",
      "started_at": "2026-06-28T16:10:00",
      "resolved_at": "2026-06-28T16:31:00"
    }
  ]
}
```
