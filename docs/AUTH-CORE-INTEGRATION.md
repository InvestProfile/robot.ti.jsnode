# Auth Core — персональный доступ T-Invest

**Актуально 2026-09-20:** пользователь разрешил ранее выбранному immutable
Auth subject обычный кабинет T-Invest вместо диагностического viewer.
[Source, deploy, проверки и rollback](AUTH-CORE-OPERATOR-20260920.md).
Это локальный персональный grant T-Invest, не глобальная роль admin и не права
другим пользователям/consumers. Login `admin` — исторический выбор человека;
авторизация не зависит от login, displayName или role.

## Модель доступа

`AuthCoreAdapter` работает до любых обработчиков и загрузки RuntimeConfig.
Каждый защищённый запрос проходит Auth introspection: active, service
`tinvest.robot`, валидный срок и точный user.id. Дополнительно проверяется
локальная allowlist для пары issuer + immutable subject.

- `ROBOT_AUTH_OPERATOR_SUBJECTS`: точные UUID, которым разрешён существующий
  кабинет. Production — только один ранее подтверждённый owner subject.
- `ROBOT_AUTH_VIEWER_SUBJECTS`: прежний диагностический доступ. Сам по себе
  он не открывает кабинет. При наличии operator grant тот имеет приоритет.
- Только проверенный сервером запрос получает WeakSet-метку для requireAuth.
  Заголовок/role/owner_id клиента такой меткой не являются.
- Upstream membership обязательна для обоих режимов. Даже локально допущенный
  UUID при отзыве Auth membership получает отказ на следующем запросе.

Обычный UI открывает существующие счета, портфель, журнал и другие разделы
этого экземпляра сервиса. Новая многопользовательская модель разделения
брокерских счетов не вводится: это доступ выбранного владельца к его кабинету.
Дополнительных subjects в operator allowlist добавлять без поручения нельзя.

## Маршруты

| Маршрут | Поведение |
| --- | --- |
| GET / или /viewer без SSO-cookie | 303 /auth/login → hosted Auth |
| GET /auth/login | State + PKCE, локальная транзакция 10 минут |
| GET /auth/callback | Однократный exchange + introspect; operator → /, viewer → /viewer |
| GET /auth/session | После introspect: access, session CSRF, список ограничений; без credentials/UUID/upstream token |
| GET / и assets с operator SSO | Прежний React dashboard; CSP self, cache-control no-store |
| GET /viewer с operator SSO | 303 / |
| API operator | Явный allowlist operator-access.ts + session CSRF header, включая GET |
| POST/PUT/DELETE operator | Дополнительно точная Origin; существующая валидация handler сохраняется |
| POST /auth/logout | Origin + CSRF, удаление local session, remote revoke |
| Viewer-only subject | Прежние /viewer и /api/viewer/status; прочие операции запрещены |

Все API GET требуют CSRF для operator, поскольку часть старых GET запускает
вычисления или запись кеша. Frontend получает CSRF через /auth/session и
передаёт x-csrf-token. Ни Basic password, ни client secret, ни upstream SSO
токен в браузер не передаются. JWT/role из браузера не принимаются.

Локальная политика запрещает operator SSO account-mode, live-actions,
cancel-stale-limit-orders, protective-stops-resync и social-cookies. Это
сохраняет operational ограничения и не даёт обхода через прямой HTTP.
Прочие обычные настройки проходят CSRF и прежнюю серверную валидацию.
Неизвестные новые маршруты закрыты до отдельного review.

## Ошибки, Basic, сессии

Анонимные API — JSON401 без redirect. Неверная/дублированная/истёкшая SSO-cookie
не переключается на Basic. Отказ membership/local grant — 403; недоступный
Auth — 503. Автоматического login loop нет. UI закрывается при отзыве доступа.

Explicit Basic работает отдельно только без SSO-session cookie. Его пароль
должен быть задан и отличаться от client secret. /auth/session после успешного
Basic возвращает только access=basic. Смешанные SSO+Basic запросы проверяются
по SSO, без fallback. Прежний legacy Basic scope не расширяется этим изменением.

Browser cookie — случайный __Host-tinvest-session, Secure/HttpOnly/SameSite=Lax,
Path=/, без Domain. Upstream token хранится только в памяти сервера. Local
session ограничена upstream сроком и 8 часами; restart требует нового входа.
Лимит — 1000 sessions и 1000 login transactions. Introspection не кешируется.
Logout завершает consumer session, не общий сеанс Auth. При сбое remote revoke
local session уже удалена, ответ 503 + remoteRevoked=false. Отзыв не отменяет
уже исполняющийся запрос. Несколько реплик без общего session store не поддержаны.

## Конфигурация и transport

- Issuer: https://auth.vpn (`ROBOT_AUTH_ORIGIN`).
- Consumer: https://tinvest.robot.vpn (`ROBOT_AUTH_CONSUMER_ORIGIN`).
- Callback: https://tinvest.robot.vpn/auth/callback; client/service tinvest.robot.
- `ROBOT_AUTH_SECRET`: прежний отдельный client secret из protected env.
- Оба локальных subject списка указаны выше; operator принимает только UUID,
  пустые списки никого не допускают. Частичный/невалидный Auth config не
  запускает HTTP-server. Полное отсутствие всех Auth переменных оставляет Basic.

Auth-side registration/membership/client/catalog не менялись. Прежние HTTPS,
CA bundle, backchannel extra_hosts, loopback backend и nginx ACL сохраняются.
Backchannel redirects запрещены, timeout 3s, точный Origin и client credential.
Auth query/headers/cookies не логируются приложением; proxy logging и границы
исторического аудита см. [handoff](AUTH-CORE-HANDOFF-20260919.md).

## Проверки и история

Текущий [отчёт 2026-09-20](AUTH-CORE-OPERATOR-20260920.md) содержит offline HTTP
integration, browser QA на точной сборке, live безопасные probes, backup и
готовый scoped rollback. Агент не запускал production scan/trades и не менял
стратегию. Paused startup не запускает trading process/preview warmup.

Исторические этапы: [активация SSO](AUTH-CORE-DEPLOYMENT-20260919.md),
[анонимный redirect](AUTH-CORE-UX-20260919.md),
[прежний viewer](AUTH-CORE-VIEWER-20260919.md).
