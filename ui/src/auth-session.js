let session;
let pending;
const nativeFetch = (...args) => fetch(...args);

export async function getSession() {
  if (session) return session;
  if (!pending) {
    pending = nativeFetch('/auth/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      .then(async (response) => {
        if (!response.ok) throw Object.assign(new Error('Не удалось проверить доступ'), { status: response.status });
        const data = await response.json();
        if (!['operator', 'basic'].includes(data.access)) throw Object.assign(new Error('Доступ к кабинету не разрешён'), { status: 403 });
        if (data.access === 'operator' && typeof data.csrfToken !== 'string') throw new Error('Некорректная сессия');
        session = data;
        return data;
      }).finally(() => { pending = undefined; });
  }
  return pending;
}

export function clearSession() { session = undefined; }

export async function sessionFetch(input, options = {}) {
  const auth = await getSession();
  const target = new URL(input, window.location.origin);
  if (target.origin !== window.location.origin) throw new Error('Запрос за пределы сервиса запрещён');
  const headers = new Headers(options.headers);
  if (auth.access === 'operator') headers.set('x-csrf-token', auth.csrfToken);
  const response = await nativeFetch(target.href, { ...options, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (response.status === 401 || response.status === 403) {
    const data = await response.clone().json().catch(() => ({}));
    if (response.status === 401 || data.error === 'Viewer access denied') {
      clearSession();
      window.dispatchEvent(new CustomEvent('robot-session-ended', { detail: response.status }));
    }
  }
  return response;
}
