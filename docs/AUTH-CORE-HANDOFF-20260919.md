# AUTH-COORD-20260919 — дополнительные доказательства приёмки

Auth owner принял серверный контракт и отчёт `5eaaa6a` / deployment doc.
В ответ на запрос уточнений выполнены только read-only проверки 2026-09-19.
Новых HTTP smoke, сессий, деплоя, изменений secrets/membership или торговли нет.
Trading-control не изменялся. Pause=true и live actions sell сохранены.

## Subject и отдельный client credential

Сравнение выполнено непосредственно на Hyperion, без вывода значений, UUID или
хешей секретов. Источники: конфигурация работающих `auth-core` и
`robot_ti_jsnode` через docker inspect; Auth SQL transaction `BEGIN READ ONLY`
с выборкой active user `admin`, active service `tinvest.robot` и memberships.

| Проверка | Результат |
| --- | --- |
| Active membership tinvest.robot | 1 |
| Локальные ROBOT_AUTH_VIEWER_SUBJECTS | 1 |
| Множество membership user_id = локальным subjects | true |
| Обе стороны содержат ровно выбранного active Auth admin | true |
| AUTH_TINVEST_SECRET = ROBOT_AUTH_SECRET, оба присутствуют | true, compare_digest |
| Секрет отличается от ROBOT_WEB_PASSWORD | true |
| Секрет отличается от остальных присутствующих client secrets Auth | true |
| Issuer обеих сторон | совпадает, https://auth.vpn |
| Callback Auth = consumer origin + /auth/callback | совпадает, https://tinvest.robot.vpn/auth/callback |

Также локально на сервере сравнены соответствующие client secret в защищённых
`/home/mil/auth-core/runtime/app.env` и
`/home/mil/robot.ti.jsnode/runtime-env/auth-core.env` с конфигурацией контейнеров:
оба совпадают, оба файла 0600. Содержимое и хеши не выводились/не сохранялись.
Успешные exchange/introspect/revoke уже подтверждены сохранённым E2E evidence;
это дополнительная конфигурационная сверка, а не новый live smoke.

`admin` — конкретный выбранный человеком Auth subject, не передаваемая SSO роль.
Доступ определяется issuer+user.id, текущей membership и независимым локальным
viewer grant. Разрешены только диагностика процесса /viewer и
/api/viewer/status. Счета и operator/trade полномочия отсутствуют; Basic отдельный.

## Охват логирования и пределы доказательства

| Участок | Проверено read-only |
| --- | --- |
| T-Invest nginx HTTP/HTTPS | tinvest_safe без query; обе /auth/* location имеют access_log off, error_log /dev/null; вложенных include в vhost нет |
| Auth nginx HTTP/HTTPS/backchannel | access_log off и error_log /dev/null; вложенных include в vhost нет |
| Работающий Auth app.mjs | logger:false; NODE_DEBUG http/https/net/tls и --trace-tls не включены |
| Работающий build/http/auth-core.js | console calls отсутствуют; NODE_DEBUG http/https/net/tls и --trace-tls не включены |
| Docker stdout/stderr Auth | json-file, max-size 10m/max-file 3; в последних 500 строках auth query patterns не обнаружены |
| Docker stdout/stderr robot | json-file, explicit rotation options отсутствуют; в последних 500 строках auth query patterns не обнаружены |
| T-Invest nginx error.log | прочитано до 256 KiB с конца, auth query patterns не обнаружены |
| Rsyslog Hyperion | active; проверены /etc/rsyslog.conf и /etc/rsyslog.d/{50-default,20-ufw}.conf: nginx/docker/imfile и forwarding directives не обнаружены |
| Специализированные log shippers | среди запущенных containers и systemd services не обнаружены имена filebeat/fluent/promtail/vector/logstash/syslog-ng |

Проверка выборок искала auth URL (`/auth/` или `sso_client`) вместе с query
code/state/code_challenge/token; она не доказывает отсутствие всех возможных
форматов секретов. Строки логов и запросов не выводились.

**Не закрыто:** nginx tinvest access.log, общий access.log и error.log недоступны
пользователю mil. Архивы/ротации, root-only логи, неуправляемые forwarders,
внешние proxy/collectors и browser/device logs полностью не проверены.
Формулировка «вся auth-цепочка гарантированно никогда не логировала query»
не подтверждена. Подтверждены текущие контролируемые настройки и ограниченные
читаемые выборки. Отдельных привилегий или новых root-операций не запрашивали.

## Health probe inventory

Без отправки HTTP-запросов проверены:

- Healthcheck всех запущенных Docker containers: ссылок на T-Invest/5757 или
  /api/health не найдено. У robot_ti_jsnode Docker Healthcheck отсутствует;
  у Auth он есть (собственная проверка Auth, не consumer probe).
- 70 читаемых файлов в /etc/cron.d, /etc/systemd/system,
  /home/mil/.config/systemd/user, /home/mil/skystream-monitor/config,
  /home/mil/skystream-vds-monitor. Не включались env/key/DB, журналы, backups,
  node_modules и файлы больше 1 MiB. Найдены только TLS renewal units и
  ссылки на workload inventory в seed.json, не T-Invest HTTP health probe.
- Crontab пользователя mil и /etc/crontab: ссылок на T-Invest/5757/api/health нет.
- Активный mount Monitor `/home/mil/skystream-monitor/config/targets.json`:
  ссылок на T-Invest/5757/api/health нет. Seed.json — исходный workload snapshot,
  его упоминания контейнеров/сервисов не являются настроенными HTTP probes.
- Фактический mount VictoriaMetrics
  `/home/igorjan/victoriaMetrics/prometheus.yml`: один scrape job, нет
  T-Invest/api/health references и blackbox /probe jobs.
- /etc/prometheus и /etc/victoriametrics на Hyperion отсутствуют; реальный
  VictoriaMetrics mount проверен отдельно, как указано выше.

Итог: в проверенной управляемой конфигурации consumer HTTP health probe не найден.
Это **не полная инвентаризация внешних** проверок: root/другие user crontabs,
другие серверы, SaaS uptime services и пользовательские задания не охвачены.
Владельцу мониторинга остаётся подтвердить внешние probes и их потребителей.
Новые probes или Basic credentials не создавались. Если внешний probe существует,
/api/health требует явный Basic без SSO-cookie; anonymous/SSO health не разрешён.

## Следующий шаг и отложенное

Передать это дополнение Auth owner для приёмки доказательств; серверный контракт
им уже принят. Полный log audit и внешние probes остаются явно ограниченными
по охвату. Не повторять выполненные E2E/deploy; откат не требуется и не выполнялся.
Logout/revocation и rollback см. [актуальный контракт](AUTH-CORE-INTEGRATION.md)
и [отчёт развёртывания](AUTH-CORE-DEPLOYMENT-20260919.md).

Mac выключен: device CA trust, password GUI E2E и private inventory ожидают Mac.
Это не отменяет ранее пройденного серверного HTTPS E2E на временных сессиях.
Секреты и private inventory на Athena не копировались.
