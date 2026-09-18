# Auth Core: задание для T-Invest Robot

Дата: 2026-09-18. Пользователь попросил записать задание непосредственно в кодовый проект.
Статус: записано в файлы проекта; доставка в чат и принятие владельцем не подтверждены.

## Источник и контракт

Auth Core: ветка `codex/multi-service-sso`, commit `9003f5ff71fb9505e412383c89d3f5f29ee01801`.
[Общий контракт и owner review](https://gitlab.vpn/codex/auth-core/-/blob/9003f5ff71fb9505e412383c89d3f5f29ee01801/docs/multi-service-sso.md).
Baseline `e823ce9` содержит XContest SSO. Новые клиенты выключены без конфигурации.
Auth-проверки: 23 теста, typecheck и build прошли. Новая ветка не выложена.
Для этого сервиса client_id/service key: `tinvest.robot`.

## Задача

Добавить адаптер к `app/http/readonly-server.ts` перед dispatch защищённых маршрутов. Первый этап: только явно разрешённые read-only маршруты. Проверить GET-обработчики на побочные эффекты; одного HTTP-метода недостаточно. Для SSO viewer запретить изменение account-mode, live-actions, risk/sell settings, cancel-stale-limit-orders, protective-stops-resync и social-cookies. Не подменять действующий операционный доступ простой membership. Не запускать заявки, broker API или production DB ради проверки.

Подготовить локальную реализацию и offline tests с синтетическими данными
(для XContest: gap review существующей реализации). Сначала прочитать локальные
правила и актуальные контрольные документы. Сохранить параллельные изменения.
Этот запрос не разрешает deploy, provisioning, изменение memberships или live auth tests.

## Обязательные границы

- HTTPS hosted login Auth; отдельный credential клиента, точный callback.
- Browser-bound state + PKCE S256; код одноразовый, максимум 60 секунд.
- Exchange/introspect/revoke только сервер-сервер. Токен только на сервере,
  отдельная HttpOnly Secure host-only cookie для браузера.
- На каждом защищённом запросе introspection: active, точный service, user.id,
  expiresAt. Trusted actor = (настроенный Auth origin, user.id).
- Membership не является admin/ролью/правом торговли. В текущем контракте Auth
  не передаёт роли. Нужна отдельная серверная проверка разрешённых операций.
- Не доверять owner_id/role headers и не связывать аккаунты автоматически по имени/email.
- Timeout/malformed response: fail closed; никакого автоматического legacy fallback.
- Мутации: Origin + CSRF + явное разрешение. Logout учитывает отзыв родительской
  сессии и membership; не обещать отмену уже выполняющихся операций.
- Callback query и credentials не попадают в логи. Не читать/печатать secrets.
- Запуск из Auth в новой вкладке без opener; исходная вкладка сохраняется.

## Проверки и ответ Auth

Offline: success, отсутствие membership, неверный client/secret/callback/state/PKCE,
expiry/replay, cross-client isolation, прямое API-обращение, revocation,
timeout, CSRF, запрет мутаций viewer, cookie attributes.
Не использовать рабочие торговые процессы/очереди/учётные записи как test harness.

Вернуть commit, список изменённых маршрутов, результаты тестов, точные HTTPS
origin/callback, источник прав и mapping, нерешённые вопросы, план совместного
rollout/rollback. Согласование владельцем не считать состоявшимся до его ответа.

