# Читаемый SSO viewer T-Invest

Запрос пользователя: после SSO показать интерфейс вместо сырого JSON.
Source: `95206a1` + `b69d1a8` (точная финальная версия).

## Что видно пользователю

`/viewer` показывает «Обзор состояния» в дизайне существующего UI: тёмная
палитра, карточки, рамки и типографика из ui/src/styles.css. Доступны рабочий
цикл, автоматическая защитная блокировка, количество ошибок подряд, запуск
процесса, начало/конец последнего цикла, время обновления в UTC. Отсутствующие
поля обозначаются «Нет данных»/«Пока нет данных». Блокировка не представляется
как разрешение на торговлю; текущие pause/sell не выводятся из этого флага.

«Обновить» запрашивает только существующий `/api/viewer/status`, показывает
загрузку и результат. 401/403 скрывают снимок; 401 предлагает ручной вход,
403 не запускает login loop. При сетевой ошибке/503 данные обозначены как
потенциально устаревшие. Автоматического polling нет.

«Выйти» использует существующий POST /auth/logout с прежним CSRF/Origin.
При подтверждённом выходе данные скрываются. Ответ remoteRevoked=false
отличается от неизвестного результата при ошибке прокси/сети; успешный выход
не заявляется без подтверждения. Без JS доступна серверная страница и form
logout; для обновления используется перезагрузка браузера.

Основной React UI не подключён: его загрузка вызывает операторские API счетов,
позиций и прочих данных. Счета, портфель, журнал и торговые действия не входят
в эту реализацию; расширение данных требует отдельного согласования и аудита.

## Защитные границы

Изменены только auth-core.ts/.test.ts и новый viewer-page.ts/.test.ts.
readStatus и его шесть полей не расширялись. UUID allowlist, memberships,
issuer/client credentials, introspection/revocation, Basic и API-контракт
остались прежними. Статусы 401/403/503 и правила redirect не изменены.

HTML использует whitelist полей, экранирование, DOM textContent и отдельный
криптографический nonce на каждый ответ для inline CSS/JS. CSP не содержит
unsafe-inline; connect-src self, frame-ancestors none, form-action self,
base-uri none. Operator assets/API не подключаются.

## QA

Локально: npm test **418/418**, TypeScript/UI build и npm run lint — pass.
Дополнительные тесты: неизвестные/опасные поля не рендерятся, атрибуты
экранируются, отсутствующие данные обработаны, CSP nonce меняется на каждом
ответе. Прежние SSO/PKCE/CSRF/revocation/permission тесты сохранены.

Browser plugin not available; использован установленный Playwright Chromium.
QA на localhost:18769 с настоящим AuthCoreAdapter и mock Auth/данными; без
production cookie, credentials или Auth sessions. Cookie-header и Origin
в тестовом harness синтетические; это UI QA, не проверка production SSO login.

| Проверка | Desktop 1440×1000 / mobile 390×844 |
| --- | --- |
| URL/title, содержимое, отсутствие error overlay | pass / pass |
| Ошибки JS/console, CSP нарушения | 0 / 0 |
| Горизонтальное переполнение | нет / нет |
| Обновить → загрузка → обновлённое состояние | pass / pass |
| 401/403 скрывают данные, без redirect loop | pass / pass |
| 503 показывает stale/error message | pass / pass |
| Выход, подтверждённый remote outage, неподтверждённая proxy error | pass / pass |

Скриншоты визуально просмотрены. Evidence на Athena:
`/tmp/tinvest-viewer-{desktop,mobile}.png`, варианты `-401/-403/-503.png`,
`/tmp/tinvest-viewer-qa.log`, `/tmp/tinvest-viewer-qa.cjs`,
`/tmp/tinvest-viewer-tests.log`, `/tmp/tinvest-viewer-lint.log`.
Другие браузеры и вход с пользовательским паролем в этом UI QA не проверялись.


## Production deploy и rollback

Deploy завершён **2026-09-19 14:05:03 UTC**. Active release:
`/home/mil/releases/robot-ti-viewer-b69d1a8`; Compose:
`/home/mil/robot.ti.jsnode/docker-compose.robot-viewer-b69d1a8.yml`.
Текущая safety+SSO база скопирована; только четыре viewer-файла наложены
через git archive b69d1a8. Полный HEAD не развёртывался.
Изолированный production test container: network none, dummy DB,
read-only node_modules, без production env; **316/316**, build/UI/lint pass.

После переключения только robot:
- Image, полный environment и port bindings совпали с прежними;
  /code read-only. DB/social/observation containers не пересоздавались.
- HTTPS с проверкой CA/hostname: / и /viewer anonymous 303, /auth/login ведёт
  на прежний Auth client/callback; API status/health/viewer-status — 401.
- Invalid SSO-cookie + Basic: 401, без fallback/redirect.
- Explicit operator Basic /api/status: 200; pause=true, live actions=[sell].
- Исходники и скомпилированные viewer/auth JS совпали с проверенными локально.
  viewer-page.ts SHA256 ea363cf5767b0233f0f8ceb294e875333d51e592378dedc51e80ec925f7bcec0;
  viewer-page.js SHA256 542f3970dabc59e639e00eb85dde40a48de5f2a3d4750c72c7d6e565b6489285.

Evidence на Hyperion: `/home/mil/robot-sso-20260919/`:
`viewer-b69d1a8-tests.log`, `viewer-b69d1a8-verification.json`,
`viewer-b69d1a8-deploy.py`.
Authenticated browser QA проводился на fixture, не на production пользовательской
сессии. Live сессии, credentials и memberships для тестирования не создавались
и не менялись. Auth/Crypto/trading-control не изменялись; scans/trades не вызывались.

Rollback: сохранены `robot-ti-sso-ux-fe755bd` и
`docker-compose.robot-sso-ux-fe755bd.yml`. Перед откатом сверить текущие
pause/sell и environment, затем пересоздать только robot с предыдущим Compose.
Общий SSO rollback не использовать: он затрагивает sessions/catalog и не нужен
для UI. Откат не выполнялся.

После restart локальные SSO sessions в памяти сброшены. Для нового входа
использовать https://tinvest.robot.vpn/auth/login (существующий Auth flow).
Расширение доступа к счетам/портфелю/журналу — отдельное согласование, не блокер
реализованного process viewer. Cross-browser QA вне Chromium остаётся непроверенным.
