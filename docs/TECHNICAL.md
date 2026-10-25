> Historical note: current network, sampling and webhook delivery behaviour is documented in [NETWORK_AND_DELIVERY.md](NETWORK_AND_DELIVERY.md) and the root README.

# Pulsewatch — панель мониторинга сервисов

Панель мониторинга API и веб-сервисов: текущий статус, время ответа, uptime и журнал инцидентов.

## Возможности

- общая оценка состояния системы;
- метрики доступности и задержки;
- создание и обновление мониторов;
- журнал инцидентов с уровнями критичности;
- REST API, SQLite и интеграционные тесты;
- адаптивная тёмная тема.

## Запуск

```bash
pnpm install
pnpm start
```

Откройте `http://localhost:4400`. На Windows доступен `start-local.cmd`.

```bash
pnpm test
```

## Текущий режим работы
Фоновый сборщик работает вместе с Node-процессом. Проверяются только HTTPS-адреса доменов из MONITOR_ALLOWED_HOSTS; приватные IP и переходы на другие домены запрещены. Измеряется время до HTTP-заголовков, доступность — доля успешных наблюдений за период хранения, без SLA. Старые записи сохранены, но ручные статусы не включаются в измерения. Авторизация и внешние уведомления требуют настройки перед публичным размещением.

## Сбор измерений
`MONITOR_ENABLED=true`, `MONITOR_INTERVAL_SECONDS=60`, `MONITOR_RETENTION_DAYS=30`. Разрешённые домены задаёт `MONITOR_ALLOWED_HOSTS` через запятую. Пример настройки — в `.env.example`; чтение переменных явно: `node --env-file=.env.example server.js`. До 30 целей, одна одновременная проверка.

`POST /api/check` запускает цикл; `PATCH /api/monitors/:id/enabled` включает или приостанавливает цель. `GET /api/overview` возвращает измерения, график и инциденты. Значения без наблюдений — `null`, а не 100% доступности.
