# Персональный SSO-доступ к обычному кабинету T-Invest

Прямое поручение пользователя 2026-09-20 отменяет viewer-only UX для ранее
выбранного Auth account. Source: `e214c3f` + `4c0265b`.

## Авторизация

Владелец Auth подтвердил private owner evidence:
`/tmp/auth-multi-service-sso/docs/crypto-owner-handoff-20260919.md`,
раздел User selection confirmed by read-only lookup, commit `03f71ac`.
Read-only сравнение без вывода UUID: ровно этот immutable subject совпадает
с текущим ROBOT_AUTH_VIEWER_SUBJECTS и имеет active membership tinvest.robot.
Выбор по login, displayName, role или данным запроса не выполнялся.

Новый локальный `ROBOT_AUTH_OPERATOR_SUBJECTS` содержит только этот UUID.
Issuer/client/callback, Auth membership и client credentials не изменяются.
Никаких глобальных admin grants или прав другим consumers/users.
Auth owner подтвердил: Auth-side изменений не требуется.

Каждый запрос проходит текущую introspection и проверку точного subject.
Успешно проверенный запрос помечается серверным WeakSet; существующий
requireAuth принимает эту метку, не header и не подставленный Basic.
Для API, включая вычисляющие GET, требуется session CSRF header.
Для POST/PUT/DELETE дополнительно обязательна точная Origin.
CSRF выдаётся GET /auth/session только после интроспекции; Basic-credential
и upstream Auth token в браузер не выдаются. Старый Basic независим.

Анонимные API возвращают JSON401. Неверная SSO-cookie не переключается на
Basic. Revocation/denied subject — 403, Auth outage — 503, без login loop.
Клиент снимает весь кабинет с экрана при отзыве; конкурентный 401 не заменяет
уже полученный 403 предложением нового входа. Assets тоже проверяют сессию,
cache-control no-store. JS CSP — self, без unsafe-inline; inline styles
разрешены для существующих React styles, frame-ancestors/base-uri none.

## Обычный интерфейс и функции

После callback открывается `/`, прежний `/viewer` для operator ведёт на `/`.
Загружается существующий React dashboard production-базы, не новый viewer:
обзор, счета/портфель, сделки, журнал, покупки/продажи, Pulse/профили и
аналитические разделы, существующие в production UI.

Открыты прежние API кабинета по явному списку operator-access.ts. Работают
обычные настройки order-type, market-regime, risk-settings, sell-settings и
CRUD социальных профилей; все проходят CSRF и существующую валидацию.
Агент эти настройки не менял и реальные scan/аналитические задания не запускал.
Сами пользовательские GET-вычисления остаются обычными функциями интерфейса.

Сервером заблокированы для нового SSO-доступа:
- account-mode и live-actions — переключение счетов в trade/снятие sell-only;
- cancel-stale-limit-orders и protective-stops-resync — прямые брокерские действия;
- social-cookies — изменение credentials, не часть персонального доступа.
Новые неизвестные маршруты не получают автоматического разрешения.
Пауза, live-lock, sell-only и брокерские credentials не меняются.

При paused=true entrypoint теперь запускает HTTP, но не startTradingProcess;
автоматический preview warmup также пропускается. Это предотвращает запуск
циклов/сканирования при UX deploy; торговая стратегия не меняется. Отдельные
существующие collector/observation containers не входят в переключение.

## Проверки

Локально npm test: **428/428**, build/UI/lint pass. Помимо unit-проверок:
- HTTP integration с настоящим readonly-server, mock Auth и mock persistence:
  callback → существующий index.html, API/status, CSRF до handler,
  успешный mock settings handler и блокировка live-actions/revocation.
- Изолированный startup test: при pause стартует HTTP ровно один раз,
  trading process не стартует. Нет производственной БД/брокера/сканирования.
- Playwright Chromium desktop1440×1000 и mobile390×844 с синтетическими
  ответами API: обычный dashboard, навигация Счета/Сделки/Журнал, refresh,
  CSRF на всех API, отсутствие Basic header, отзыв закрывает UI, logout.
  Ошибок JS/console нет. Browser plugin отсутствует. Новые функции UI не
  проверяются на реальных аккаунтах через браузер, чтобы не запускать scan.

QA evidence на Athena: `/tmp/tinvest-operator-tests.log`,
`/tmp/tinvest-operator-lint.log`, `/tmp/tinvest-operator-qa.log`,
`/tmp/tinvest-operator-qa.cjs`, `/tmp/tinvest-operator-{desktop,mobile}.png`.
Визуально подтверждён существующий dashboard, отдельный viewer не используется.


## Deploy evidence

Развёрнуто **2026-09-20 04:36:08 UTC**:
`/home/mil/releases/robot-ti-access-4c0265b`, Compose
`/home/mil/robot.ti.jsnode/docker-compose.robot-access-4c0265b.yml`.
Deployment helper: `ops/auth-core/deploy-operator-access.py`, commit `a1e46fd`.

Production-база `robot-ti-viewer-b69d1a8` сохранена. 11 файлов app/ui изменены
через целевой overlay; файлы стратегии не менялись, full HEAD не развёртывался.
Exact release: **326/326** тестов, build/UI/lint pass в контейнере network none,
dummy DB, read-only dependencies, без live env. Точные production assets и
compiled Auth adapter также скопированы на Athena для повторного Playwright
QA с mock API; desktop/mobile прошли. `/tmp/tinvest-operator-production-qa.log`.

Новый защищённый файл `runtime-env/auth-operator-4c0265b.env` (0600) содержит
ровно один pinned subject. Все остальные env entries, image и port bindings
совпали. Полный safe effective config до/после совпал, включая pause=true,
sell-only и live confirmation. БД, social collector и observation worker
не пересоздавались. Auth/Crypto/trading-control не изменены.

Live HTTPS probes с проверкой CA/hostname:
- anonymous / и /viewer → 303 /auth/login, без Basic challenge;
- anonymous /api/status, /api/accounts, /api/positions, /auth/session → JSON401;
- explicit Basic /api/status и /auth/session → 200; Basic session metadata
  не содержит CSRF/token/credential, только access=basic;
- invalid SSO-cookie вместе с Basic → 401 без fallback;
- read-only SQL: выбранный pinned UUID по-прежнему имеет active membership;
- runtime не содержит начатого trading tick; startup logs подтверждают HTTP-only
  при паузе, без Trading process started / Trading tick started / Preview cache warmed.

Полный production browser login и broker-backed вкладки агент не открывал:
это запустило бы обычные аналитические GET и дополнительные запросы брокера.
SSO callback → обычный HTML/API/CSRF/revocation проверены на настоящем HTTP
handler с mock Auth/persistence; production grants/routes/config проверены отдельно.
Production Auth sessions/credentials/memberships для тестов не создавались.

Evidence на Hyperion: `/home/mil/robot-sso-20260920/`:
`access-4c0265b-tests.log`, `access-4c0265b-manifest.json`,
`access-4c0265b-verification.json`, `access-4c0265b-startup.json`.
Backup (0700): `access-4c0265b-backup/compose.yml` и `safe-config.json`.

## Вход и rollback

URL: **https://tinvest.robot.vpn/auth/login** → Auth → обычный кабинет `/`.
Перезапуск сбросил локальные sessions: использовать этот вход, не старую cookie.

Подготовлен отдельный безопасный rollback release:
`/home/mil/releases/robot-ti-access-rollback-4c0265b`, Compose
`/home/mil/robot.ti.jsnode/docker-compose.robot-access-rollback-4c0265b.yml`.
Это прежний viewer release с сохранёнными paused-start и preview-warmup guards
(и startup regression test). Он не подключает новый operator env file.
Перед откатом сверить текущие pause/sell/live-lock, затем переключить только
robot этим Compose. БД/membership/client/catalog откатом не изменяются.
Не использовать старый Compose вслепую: его entrypoint запускал циклы при pause.
Rollback подготовлен, но live переключение назад не выполнялось.
Rollback release прошёл отдельные build, paused-start regression test (1/1)
и lint; rollback Compose прошёл config --quiet. Evidence:
`/home/mil/robot-sso-20260920/access-4c0265b-rollback-tests.log`.
