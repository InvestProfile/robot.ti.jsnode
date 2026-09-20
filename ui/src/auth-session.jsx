import React, { useEffect, useState } from 'react';
import { clearSession, getSession, sessionFetch } from './auth-session.js';

export function AuthSessionBoundary({ children }) {
  const [auth, setAuth] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    setFailure(null);
    setBusy(true);
    getSession().then(setAuth).catch(error => setFailure(error.status || 503)).finally(() => setBusy(false));
  };
  useEffect(() => {
    load();
    const ended = event => { setAuth(null); setFailure(current => current === 403 ? 403 : event.detail); };
    window.addEventListener('robot-session-ended', ended);
    return () => window.removeEventListener('robot-session-ended', ended);
  }, []);
  const logout = async () => {
    setBusy(true);
    try {
      const response = await sessionFetch('/auth/logout', { method: 'POST' });
      const data = await response.json();
      if (!(response.ok && data.ok === true) && !(response.status === 503 && data.remoteRevoked === false)) throw new Error('unconfirmed');
      clearSession(); setAuth(null); setFailure(response.ok ? 'logout' : 'remote-outage');
    } catch { setFailure('logout-unknown'); }
    finally { setBusy(false); }
  };
  if (!auth) return <main><h1>T-Invest Robot</h1><p role="status">{busy ? 'Проверяем доступ…' : failure === 401 ? 'Сессия завершена. Войдите снова.' : failure === 403 ? 'Доступ к кабинету не разрешён.' : failure === 'logout' ? 'Вы вышли из T-Invest Robot.' : failure === 'remote-outage' ? 'Локальный сеанс завершён. Удалённый выход пока не подтверждён.' : 'Auth временно недоступен.'}</p>{[401, 'logout', 'remote-outage'].includes(failure) ? <a href="/auth/login">Войти через Auth</a> : failure !== 403 ? <button className="icon-button" disabled={busy} onClick={load}>Повторить</button> : null}</main>;
  return <>
    {auth.access === 'operator' ? <div className="sso-session-bar"><span>Личный кабинет · SSO</span><span>Пауза и ограничения live сохраняются. Включение торговли и брокерские операции заблокированы.</span><button className="icon-button" disabled={busy} onClick={logout}>Выйти</button>{failure === 'logout-unknown' ? <span role="alert">Выход не подтверждён. Повторите попытку.</span> : null}</div> : null}
    {children}
  </>;
}
