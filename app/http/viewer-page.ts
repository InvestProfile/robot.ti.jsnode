// A standalone process-status view. Never imports the operator UI or its API clients.
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('ru-RU', { timeZone: 'UTC' }) + ' UTC' : 'Пока нет данных';

const css = `
:root{color-scheme:dark;--bg:#0b1016;--surface:#121920;--line:#263442;--text:#eef3f8;--muted:#b9c4d0;--blue:#70b7ff;--yellow:#ffd76a;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--bg)}
*{box-sizing:border-box}body{margin:0;min-width:320px}header{border-bottom:1px solid var(--line);background:#0f171f}header>div,main{max-width:1120px;margin:auto;padding:24px}header>div{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px}.mark{display:grid;place-items:center;width:42px;height:42px;border:1px solid #2d80ed;border-radius:8px;background:#172232;color:var(--blue);font-weight:750}.brand strong,.brand small{display:block}.brand small{color:var(--muted);margin-top:4px}.badge{border:1px solid var(--line);border-radius:20px;padding:7px 12px;color:var(--blue);font-size:13px}h1{font-size:30px;margin:0 0 8px}h2{font-size:17px;margin:0 0 16px}p{color:var(--muted);line-height:1.6;margin:8px 0}.top{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:12px 0 24px}.actions{display:flex;gap:10px;flex-wrap:wrap}button,.login{font:inherit;display:inline-block;min-height:44px;border:1px solid var(--line);border-radius:8px;padding:10px 16px;background:#17212c;color:var(--text);cursor:pointer;text-decoration:none}button.primary{border-color:#457eae;color:var(--blue)}button:hover,.login:hover{background:#213344}button:focus-visible,a:focus-visible{outline:3px solid var(--blue);outline-offset:3px}button:disabled{opacity:.6;cursor:wait}form{margin:0}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card,.timeline,.note{border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:22px}.label{color:var(--muted);font-size:14px}.value{font-size:24px;font-weight:650;display:block;margin:12px 0;overflow-wrap:anywhere}.card p{font-size:13px}.timeline{margin-top:20px}dl{margin:0}dl>div{display:flex;justify-content:space-between;gap:20px;padding:15px 0;border-top:1px solid var(--line)}dt{color:var(--muted)}dd{margin:0;text-align:right;overflow-wrap:anywhere}.note{margin-top:20px;background:#0f161d}.note p{margin:0;font-size:14px}#feedback{margin:0 0 20px;color:var(--yellow);line-height:1.6}#updated{font-size:13px;margin-top:20px}[hidden]{display:none!important}footer{margin-top:28px;color:var(--muted);font-size:13px}@media(max-width:700px){header>div,main{padding:18px}.top{align-items:flex-start;flex-direction:column}h1{font-size:26px}.grid{grid-template-columns:1fr}.card{padding:18px}.value{font-size:22px}dl>div{flex-direction:column;gap:8px}dd{text-align:left}.badge{font-size:12px;padding:6px 9px}.actions{width:100%}.actions button{flex:1}.actions form{flex:1}.actions form button{width:100%}}
`;

const script = `
(() => {
const byId = id => document.getElementById(id);
const refresh = byId('refresh'), logout = byId('logout'), feedback = byId('feedback');
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU', { timeZone: 'UTC' }) + ' UTC' : 'Пока нет данных';
const text = (id, value) => { byId(id).textContent = value; };
const notice = message => { feedback.textContent = message; feedback.hidden = false; };
const deny = (status) => {
 byId('snapshot').hidden = true;
 byId('signin').hidden = status !== 401;
 notice(status === 401 ? 'Сессия завершена. Войдите снова, чтобы увидеть состояние.' : 'Доступ к просмотру недоступен. Обратитесь к владельцу сервиса.');
};
async function request(path, options = {}) {
 const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000), ...options });
 return response;
}
refresh.addEventListener('click', async () => {
 refresh.disabled = true; refresh.textContent = 'Обновляем…'; byId('snapshot').setAttribute('aria-busy', 'true');
 notice('Загружаем состояние…');
 try {
  const r = await request('/api/viewer/status');
  if (r.status === 401 || r.status === 403) { deny(r.status); return; }
  if (!r.ok) throw new Error('unavailable');
  const data = await r.json(), s = data.status;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('invalid');
  text('cycle', s.isTickRunning === true ? 'Выполняется' : s.isTickRunning === false ? 'Ожидание' : 'Нет данных');
  text('breaker', s.circuitBreakerOpen === true ? 'Блокировка активна' : s.circuitBreakerOpen === false ? 'Не сработала' : 'Нет данных');
  text('errors', Number.isSafeInteger(s.consecutiveTickErrors) && s.consecutiveTickErrors >= 0 ? String(s.consecutiveTickErrors) : 'Нет данных');
  for (const [id, key] of [['started','startedAt'],['tick-start','lastTickStartedAt'],['tick-end','lastTickFinishedAt']]) text(id, date(s[key]));
  text('updated', 'Обновлено: ' + date(new Date().toISOString()));
  byId('snapshot').hidden = false; byId('signin').hidden = true; notice('Состояние обновлено.');
 } catch { notice('Не удалось обновить состояние. Данные ниже могут быть устаревшими. Попробуйте ещё раз.'); }
 finally { refresh.disabled = false; refresh.textContent = 'Обновить'; byId('snapshot').setAttribute('aria-busy', 'false'); }
});
logout.addEventListener('submit', async event => {
 event.preventDefault(); const button = logout.querySelector('button'); button.disabled = true;
 notice('Завершаем сеанс…');
 try {
  const r = await request('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(logout)) });
  if (r.status === 401 || r.status === 403) { deny(r.status); return; }
  const result = await r.json();
  if (!(r.ok && result.ok === true) && !(r.status === 503 && result.remoteRevoked === false)) throw new Error('logout');
  byId('snapshot').hidden = true; byId('signin').hidden = false;
  notice(r.ok ? 'Вы вышли из T-Invest Robot.' : 'Локальный сеанс завершён. Auth недоступен: завершение удалённого сеанса не подтверждено.');
 } catch { byId('snapshot').hidden = true; notice('Не удалось подтвердить выход. Проверьте соединение и повторите попытку.'); }
 finally { button.disabled = false; }
});
})();
`;

export function renderViewerPage(value: unknown, csrf: string, nonce: string, now: number): string {
    const s = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const cycle = s.isTickRunning === true ? 'Выполняется' : s.isTickRunning === false ? 'Ожидание' : 'Нет данных';
    const breaker = s.circuitBreakerOpen === true ? 'Блокировка активна' : s.circuitBreakerOpen === false ? 'Не сработала' : 'Нет данных';
    const errors = Number.isSafeInteger(s.consecutiveTickErrors) && Number(s.consecutiveTickErrors) >= 0 ? String(s.consecutiveTickErrors) : 'Нет данных';
    return `<style nonce="${escape(nonce)}">${css}</style>
<header><div><div class="brand"><span class="mark" aria-hidden="true">TI</span><div><strong>T-Invest Robot</strong><small>Мониторинг процесса</small></div></div><span class="badge">Только просмотр</span></div></header>
<main><section class="top"><div><h1>Обзор состояния</h1><p>Рабочий цикл и состояние защиты робота.</p></div><div class="actions"><button class="primary" id="refresh" type="button">Обновить</button><form id="logout" method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${escape(csrf)}"><button type="submit">Выйти</button></form></div></section>
<p id="feedback" role="status" aria-live="polite" hidden></p><a class="login" id="signin" href="/auth/login" hidden>Войти через Auth</a>
<div id="snapshot"><section class="grid" aria-label="Текущее состояние"><article class="card"><span class="label">Рабочий цикл</span><strong class="value" id="cycle">${cycle}</strong><p>Выполнение текущего цикла обработки.</p></article><article class="card"><span class="label">Защитная блокировка</span><strong class="value" id="breaker">${breaker}</strong><p>Состояние автоматической защиты. Не определяет разрешение на торговлю.</p></article><article class="card"><span class="label">Ошибки подряд</span><strong class="value" id="errors">${errors}</strong><p>Число последовательных ошибок рабочего цикла.</p></article></section>
<section class="timeline"><h2>Последняя активность</h2><dl><div><dt>Процесс запущен</dt><dd id="started">${escape(date(s.startedAt))}</dd></div><div><dt>Последний цикл начат</dt><dd id="tick-start">${escape(date(s.lastTickStartedAt))}</dd></div><div><dt>Последний цикл завершён</dt><dd id="tick-end">${escape(date(s.lastTickFinishedAt))}</dd></div></dl></section><p id="updated">Обновлено: ${escape(date(new Date(now).toISOString()))}</p></div>
<aside class="note"><p>Вам доступен просмотр состояния процесса. Счета, портфель, журнал сделок и управление торговлей в этот доступ не входят.</p></aside><noscript><p>Для обновления перезагрузите страницу. Выход доступен кнопкой «Выйти».</p></noscript><footer>T-Invest Robot · Время указано в UTC</footer></main><script nonce="${escape(nonce)}">${script}</script>`;
}
