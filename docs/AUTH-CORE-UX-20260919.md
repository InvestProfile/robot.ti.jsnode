# T-Invest: обычный вход через Auth

Исторический redirect rollout. Последующее обновление содержимого /viewer и
активный release: [viewer UI b69d1a8](AUTH-CORE-VIEWER-20260919.md).

Изменение пользователя: открытие страницы без авторизации должно переводить
на существующий Auth. Код: `fe755bd`, ветка `test`.

## Контракт

- Каноническая защищённая landing page — `/viewer`.
- GET `/` и `/viewer` без SSO-cookie: 303 `/auth/login`, затем существующий
  hosted Auth с прежними state/PKCE/client/callback. Basic prompt отсутствует.
- Валидная SSO на GET `/`: introspection, затем 303 `/viewer`.
- API без авторизации: 401, без redirect. Неверная/дублированная/истёкшая cookie:
  401, без автоматического повторного входа или перехода на Basic.
- Отзыв membership/local grant: 403 без redirect; сбой introspection: 503.
- Явный Basic без SSO-cookie остаётся отдельным операторским доступом.
  Viewer не получает operator/trading права. Query не становится return URL.

## Проверки

Локально `npm test`: **415/415**, build/UI build и `npm run lint` успешны.
Точная production-база с двумя заменёнными файлами `app/http/auth-core{,.test}.ts`:
**313/313** тестов. Проверка в отдельном контейнере с `--network none`,
dummy DB и read-only dependencies, без production env.

Новые тесты проверяют анонимные страницы и API, фиксированный redirect,
неверные cookies, отсутствие Basic challenge, сохранение explicit Basic,
валидную landing, 403 при отзыве/смене subject и 503 при Auth timeout.
Существующие тесты PKCE, CSRF, logout/revocation и запрета операций сохранены.


## Deploy и HTTPS probes

Переключение завершено 2026-09-19, container started 12:27:16 UTC.
Релиз `/home/mil/releases/robot-ti-sso-ux-fe755bd`; Compose
`/home/mil/robot.ti.jsnode/docker-compose.robot-sso-ux-fe755bd.yml`.
Релиз подготовлен копированием текущей safety+SSO базы и наложением двух файлов
через `git archive fe755bd`, не развёртыванием всей ветки test.

Образ, всё environment и port bindings побайтно/структурно сверены с прежним
контейнером: совпадают. Mount /code read-only. Контейнеры БД, social collector
и observation worker не пересоздавались. Auth/Crypto и trading-control не менялись.

Проверки через настоящий nginx HTTPS с проверкой CA/hostname:

| Probe | Результат |
| --- | --- |
| Анонимные GET / и /viewer | 303 /auth/login, без WWW-Authenticate |
| GET /auth/login | 303 https://auth.vpn/, прежний client/callback, state + PKCE |
| Анонимные /api/status, /api/health, /api/viewer/status | 401, без Location |
| Неверная SSO-cookie вместе с Basic: /, /viewer, /api/status | 401, без redirect/fallback |
| Явный Basic /api/status | 200; tradingPaused=true, liveAllowedActions=[sell] |

403 при отозванном grant и 503 при outage проверены offline, без отключения
Auth, создания live-сессий или изменения memberships. Пользовательский пароль
не использовался. Торговые/scan endpoints не вызывались.

Evidence на Hyperion: `/home/mil/robot-sso-20260919/ux-fe755bd-tests.log`,
`ux-fe755bd-verification.json`, `ux-fe755bd-deploy.py`.
SHA256 deployed app/http/auth-core.ts совпал с локальным fe755bd:
`2154cd9836efa10ca880859f92b11ec498eb8b6fefc6eb2da37ad1efa77ad562`.

Откат только UX: прежний релиз `robot-ti-sso-b2581b9` и прежний Compose
`docker-compose.robot-sso-b2581b9.yml` сохранены. Перед откатом сверить актуальные
pause/sell и environment; пересоздать только robot. Не запускать общий SSO
rollback, который снимает integration_ready и отзывает sessions: для этого UX
он избыточен. Откат не выполнялся.
