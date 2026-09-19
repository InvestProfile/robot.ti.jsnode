# Auth Core SSO — T-Invest, 2026-09-19

Пользователь разрешил продолжить без выключенного Mac и выбрал `admin`.
Серверная активация выполнена на Hyperion. Доступ:
**https://tinvest.robot.vpn/** (VPN). Hosted Auth: **https://auth.vpn**;
callback: **https://tinvest.robot.vpn/auth/callback**.

SSO даёт только просмотр состояния процесса. Счета, позиции, сделки и
административные операции не включены в viewer. Операционный Basic сохранён
отдельно. `ROBOT_TRADING_PAUSED=true`, live actions `sell` подтверждены до и
после переключения. Социальный сборщик и observation worker не пересоздавались.

## Релизы

- Robot: `/home/mil/releases/robot-ti-sso-b2581b9` — копия действующего
  `robot-ti-safety-42f5457` с тремя файлами адаптера из `b2581b9` (патч
  readonly-server применён к safety-базе). Другие изменения ветки test не включены.
- Compose: `/home/mil/robot.ti.jsnode/docker-compose.robot-sso-b2581b9.yml`,
  project `robottijsnode`, пересоздан только сервис `robot`.
- Источник /code read-only, runtime-env и зависимости сохранены.
- Backend теперь опубликован только как `127.0.0.1:5757:3000`; внешний вход — nginx.
- Auth image: `auth-core:multi-service-sso-9003f5f-20260919`. К предыдущему образу
  добавлены только `server/main.mjs` и `server/sso-clients.mjs` из `9003f5f`;
  frontend, зависимости, БД-схема и существующие клиенты сохранены.
- Auth previous container: `auth-core-before-tinvest-20260919` (не удалён).
- Client `tinvest.robot`, ровно одна active membership — выбранный `admin`.
  Локальный viewer grant содержит тот же Auth user.id; брокерские права не выдавались.
- Каталог Auth содержит launch URL `/auth/login`, integration_ready=true.

## HTTPS, backchannel и журналирование

- nginx слушает HTTP/HTTPS для `tinvest.robot.vpn`; HTTP перенаправляет на HTTPS,
  HTTP `/auth/*` отклоняется. Исходный VPN allowlist сохранён без расширения.
- T-Invest получил отдельную CA с ограничением имени tinvest.robot.vpn;
  срок leaf 90 дней, `tinvest-tls-renew.timer` active. Фактическое будущее продление
  ещё не проверено. Приватные ключи только root на Hyperion, `/etc/tinvest/tls`.
- Public CA: `/home/mil/robot.ti.jsnode/tinvest-vpn-root-ca.crt`;
  копия Athena: `/home/anton/.local/share/tinvest/tinvest-vpn-root-ca.crt`.
- SHA256 CA: `44:B8:A5:66:7A:A6:B2:5C:97:D2:D9:94:1F:DE:1E:2B:5D:15:18:14:66:45:05:81:41:70:66:6E:53:6F:1F:20`.
- T-Invest access log записывает метод/URI без query; для `/auth/*` access/error
  logs отключены. В vhost Auth access/error logs отключены, поскольку запрос
  hosted login несёт state/PKCE. Fastify Auth logger=false.
- Контейнерный backchannel использует `extra_hosts: auth.vpn:192.168.5.1`;
  IP робота закреплён `192.168.5.3` в прежней сети robottijsnode_default.
  Это узкая серверная маршрутизация по схеме уже существующих consumers;
  пользовательский DNS dashboard и hosts-файлы устройств не менялись.
- В Auth nginx только exchange/introspect/revoke и healthz дополнительно
  разрешены с `192.168.5.3`. Browser login ACL Auth не расширен.
- NODE_EXTRA_CA_CERTS у робота указывает на `/run/robot-env/auth-ca-bundle.crt`:
  прежний российский корневой сертификат плюс публичная CA Auth. Проверка TLS
  не отключалась. Проверен обычный fetch из нового контейнера: healthz 200.
- Секрет клиента сгенерирован на Hyperion и записан только в защищённые файлы:
  Auth `runtime/app.env` и robot `runtime-env/auth-core.env`, права 0600.
  Значение не передавалось через argv, Git, чат или память.

## Доказательства

- Точная safety+SSO сборка: локально и на Hyperion **309/309 тестов**, UI/TS
  build и lint успешны. Серверная проверка выполнялась в отдельном контейнере
  с `--network none`, dummy DB и без production env. Зависимости read-only.
- Auth `9003f5f`: **23/23** offline теста, включая PGlite.
- Реальные HTTPS проверки: PKCE/state login, cookie attributes, viewer, прямой
  API без сессии, запрет административных POST и неаудированных GET, CSRF,
  logout + remote revoke, отзыв parent-session и membership, отсутствие
  перехода на Basic при предъявленной SSO-cookie — пройдены.
- Использовались временные пятиминутные Auth-сессии выбранного admin;
  все удалены в finally. Пользовательский пароль не читался и вход с паролем
  не проверялся. Тестовые торговые операции не выполнялись.
- Реальный Basic /api/status подтвердил pause=true и live actions sell.
  После старта 04:51:21 UTC завершён цикл 04:56:01 UTC, ошибок 0.
- Регистрация существующих xcontest и skystream.monitor проверена через Auth:
  оба client lookup вернули 200; каталог T-Invest вернул точный launch URL.
- TLS-запрос с неразрешённого source address (адрес Hyperion, вне allowlist)
  получил 403; это проверка ACL, не отдельный тест из внешней сети.
- Original suites по всей ветке test ранее: 411/411. Число 309 относится к
  более узкой реально развёрнутой production-базе, а не к сокращению тестов.
- Доказательства на Hyperion: `/home/mil/robot-sso-20260919/robot-tests.log`,
  `prepared.json`, `verification.json`. Скрипты операций: `ops/auth-core/`.

## Backups и откат

- Auth DB: `/home/mil/auth-core/backups/20260919T044923Z.dump`, pg_restore --list
  выполнен. Точечное состояние service/membership и предыдущий Auth env/Compose:
  `/home/mil/robot-sso-20260919/backup` (защищённая папка).
- nginx/TLS: `/root/tinvest-backups/20260919T044432.363626Z`, включая предыдущий
  Auth vhost. Broker registry: `/var/lib/agent-secrets-broker/backups/tinvest-tls-20260919T044424.324571Z`.
- Fixed broker profile `hyperion-tinvest-tls-deploy`, destination
  `hyperion.tinvest-tls`; реальная sudo-аутентификация успешна, audit
  `b69fdbee-9f85-4fc4-bdb7-6b40df1012a2`. Прежние профили/секреты сохранены.
- Для явного отката только consumer подготовлен `ops/auth-core/rollback-sso.py`:
  возвращает safety-release, отзывает T-Invest consumer sessions и снимает
  integration_ready; сохраняет TLS, loopback-порт, паузу и sell-only.
  **Откат не выполнялся**. После него обязательно проверить Basic и состояние.
- Не восстанавливать старый Auth контейнер/env вслепую: теперь от актуальной
  multi-service регистрации зависят также другие consumers. Совместный Auth
  откат требует актуальной сверки их конфигурации. Полный DB restore для
  отключения одного consumer не нужен и здесь не разрешён.

## Отложенное и границы проверки

Mac выключен по сообщению пользователя. Установка доверия к публичной CA на
Mac/других устройствах и GUI-вход с пользовательским паролем остаются отдельным
шагом; серверный TLS проверен с явно доверенной CA, без insecure bypass.
Внешние health probes не инвентаризированы полностью; Docker healthcheck у
робота отсутствовал. `/api/health` теперь требует Basic и отсутствие SSO-cookie.

Приватный Mac inventory: обновить Hyperion T-Invest URL/TLS fingerprint,
пути ключей (без значений), timer, broker profile/audit, назначение клиентского
секрета, подтверждённую аутентификацию, backup/rollback. Сделать после включения
Mac; последняя известная задача `Memory-manager — Mac`,
`019fa8be-cf03-7d92-adc8-3c2572443806`, live routing не проверен. Никаких сообщений
на Mac не отправлялось, секреты в обход private inventory не копировались.
