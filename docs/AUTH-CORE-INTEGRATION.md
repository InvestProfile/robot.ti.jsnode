# Auth Core — локальный адаптер T-Invest

**Обновление 2026-09-19:** серверная активация выполнена после отдельного
разрешения пользователя; доступ только admin. См. [результаты, адреса и откат](AUTH-CORE-DEPLOYMENT-20260919.md). Ниже сохранён исходный статус локальной реализации.

Дата: 2026-09-18. Выполнена локальная реализация по
[запросу](AUTH-CORE-INTEGRATION-REQUEST.md). Не развёрнуто. Membership, секреты,
продуктивная БД, брокер и работающие процессы не изменялись. Принятие результата
владельцем Auth и совместная активация пока не подтверждены.

Контракт: Auth Core `9003f5ff71fb9505e412383c89d3f5f29ee01801`,
`docs/multi-service-sso.md` и `server/sso.mjs`. Это внутренний SSO, не OIDC.

## Маршруты и разрешения

Адаптер `app/http/auth-core.ts` подключён в `readonly-server.ts` **до** любых
существующих обработчиков, включая health и загрузку RuntimeConfig.

| Маршрут | Доступ / действие |
| --- | --- |
| GET / без credentials | Страница со ссылкой входа, новая вкладка, noopener/noreferrer |
| GET /auth/login | State + PKCE S256, транзакция на 10 минут, HTTPS hosted Auth |
| GET /auth/callback | Однократное потребление локальной транзакции, exchange + introspect |
| GET /viewer | Отдельная серверная страница состояния, без React/admin интерфейса |
| GET /api/viewer/status | Та же минимальная проекция состояния в JSON |
| POST /auth/logout | Точная Origin + CSRF, удаление локальной сессии и remote revoke |
| Все остальные маршруты/методы с SSO-cookie | Запрет; сначала актуальная introspection |

Оба viewer GET читают только `getTradingRuntimeState()` из памяти. Поля:
startedAt, isTickRunning, lastTickStartedAt, lastTickFinishedAt,
consecutiveTickErrors, circuitBreakerOpen. Нет счетов, позиций, настроек,
произвольного текста ошибок, БД, файловых записей, запросов брокера и очередей.
GET с query-параметрами также запрещён.

Существующие GET не включены в allowlist: например preview использует cache/
warmup, buy-scan запускает scanner, sell-brain — evaluate, positions и другие
ручки связаны с брокерскими сервисами. Остальные старые ручки также закрыты до
индивидуального аудита и согласования отображения счетов. POST/PUT/DELETE,
admin, social-cookies, paper, статические файлы и полный dashboard недоступны.

Источник авторизации: текущая introspection Auth **и** локальное разрешение
`ROBOT_AUTH_VIEWER_SUBJECTS`. Доверенный actor — пара `(ROBOT_AUTH_ORIGIN, user.id)`.
Список subjects разрешает только просмотр общей диагностики процесса. Он не
отображает пользователя на брокерский счёт и не даёт торговых прав. Email,
displayName, owner_id и role не используются для авторизации. Даже успешная
membership без локального разрешения получает отказ.

Старый операционный Basic сохраняется только при явно переданном Basic header
и полном отсутствии SSO-session cookie. Неверная/истёкшая SSO-cookie, сбой Auth
или отказ membership никогда не переключают запрос на Basic. При включённом
SSO Basic-пароль обязателен и должен отличаться от секрета клиента. Смешивать
viewer и operator лучше в разных профилях браузера: SSO-cookie имеет приоритет.

## Конфигурация и точные адреса

По умолчанию SSO выключен, если отсутствуют все четыре переменные. Частичная
невалидная конфигурация отключает HTTP-сервер, а не ослабляет авторизацию.

- `ROBOT_AUTH_ORIGIN`: доверенный точный HTTPS origin Auth, без завершающего `/`.
  Значение для совместной активации **на уточнении**, из запроса не следует.
- `ROBOT_AUTH_CONSUMER_ORIGIN`: предложено `https://tinvest.robot.vpn`.
- Callback строится строго как `${ROBOT_AUTH_CONSUMER_ORIGIN}/auth/callback`:
  **`https://tinvest.robot.vpn/auth/callback`**. HTTPS/DNS здесь не проверялись.
- Client/service жёстко заданы: **`tinvest.robot`**.
- `ROBOT_AUTH_SECRET`: отдельный secret минимум 32 символа; должен соответствовать
  `AUTH_TINVEST_SECRET` на Auth. Никакого provisioning в этой задаче.
- `ROBOT_AUTH_VIEWER_SUBJECTS`: через запятую точные Auth user.id, разрешённые
  владельцем. Пустой список никого не допускает.
- На Auth зарегистрировать точный `AUTH_TINVEST_CALLBACK` только при rollout.

Токен Auth хранится в памяти процесса, браузер получает отдельный случайный
`__Host-tinvest-session`. Cookie: Secure, HttpOnly, Path=/, SameSite=Lax, без Domain.
Login cookie имеет те же атрибуты. Сессия ограничена сроком Auth и 8 часами;
перезапуск завершает локальные сессии. Ограничение 1000 сессий и 1000 ожидающих
транзакций; истёкшие очищаются при запросах. Это однопроцессный адаптер; общий
session store для нескольких экземпляров не реализован.

Introspection не кешируется. Backchannel: HTTPS, redirects запрещены, timeout
3 секунды, точный Auth Origin и отдельный Bearer credential. Ошибки возвращаются
без upstream-текста. Callback query не логируется приложением; proxy должен
также исключить query, cookies, headers и тела auth-запросов из журналов.
Logout удаляет локальную сессию даже при недоступности Auth, возвращая 503 и
remoteRevoked=false. Он не завершает общую Auth-сессию. Отзыв действует на
следующий проверенный запрос, не отменяет уже исполняющийся.

## Проверки

`app/http/auth-core.test.ts`: синтетический backchannel, нет сетевых запросов,
запуска trading server, производственной БД или брокерского API. Проверяются
PKCE/state/browser binding, неправильные secret/client/callback, expiry/replay,
локальный grant, cross-client ответ, revocation, timeout/malformed/redirect,
CSRF/logout, запрет mutation/неаудированных GET, cookie, отсутствие fallback.
Срок 60 секунд и атомарное потребление кода обеспечивает Auth; потребитель не
может независимо определить возраст opaque code. Его fake проверяет контракт,
но не подменяет SQL-тесты Auth.

Полный `npm test` и `npm run lint` выполняются в отдельной копии исходников
с dummy DB-конфигурацией и выключенными profile integration tests. Дополнительно
проверяется оригинальный Auth SSO test suite из указанного commit на PGlite,
без внешней БД. Итоговые числа см. в записи приёмки ниже.

## Совместный rollout / rollback — ещё не выполнялся

1. Подтвердить Auth origin, HTTPS consumer/callback и владельцев доступа.
   Согласовать, достаточно ли первой фазы диагностики; для финансовых данных
   нужна отдельная модель subject → account → permission.
2. Подготовить согласованные версии Auth/consumer и отдельный секрет через
   защищённый runtime-конфиг. Явно согласовать membership и локальные subjects.
3. Проверить proxy logging и мониторинг: при включённом SSO старый /api/health
   теперь требует корректный Basic и без SSO-cookie. Анонимного DB health нет.
   Обновление health probe нужно подготовить **до** активации.
4. Выполнить согласованный rollout и совместную проверку HTTPS, входа/отказа,
   logout/revocation на безопасных данных без операций торговли. До этого
   статус интеграции не считать production-ready.
5. При откате сначала закрыть SSO-вход на proxy/consumer, отозвать client sessions,
   восстановить согласованные версии и конфиги. Не использовать автоматический
   fallback. Проверить сохранность операционного Basic и ограничений торговли.
   Не удалять memberships/секреты до проверки зависимостей и отдельного решения.

Открыто: окончательные HTTPS origins, список subjects/membership, proxy logs,
health probes, будущая модель доступа к счетам, подтверждение владельца Auth.
Сам документ не означает отправку сообщения владельцу или его согласие.

## Локальная приёмка, 2026-09-18

- `npm test`: **411/411**, включая **27** новых проверок адаптера; TypeScript
  и production UI build успешны. Реальные profile API integration tests
  намеренно выключены, как в обычном offline unit suite.
- `npm run lint`: успешно, без предупреждений.
- Auth `9003f5f`: `node --test test/sso.test.mjs test/sso-clients.test.mjs`:
  **10/10**, оригинальные SQL/registration проверки на in-memory PGlite.
  Это отдельные component suites; совместный HTTPS E2E не выполнялся.
- Артефакты текущей локальной проверки: `/tmp/robot-auth-tests.log`,
  `/tmp/robot-auth-lint.log`, `/tmp/robot-auth-contract.log` (временные файлы).
- Commit реализации указан в сообщении о завершении; этот документ и исходный
  запрос сохранены вместе с кодом. Отчёт готов для владельца Auth, но сообщение
  ему не отправлялось.
