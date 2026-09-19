#!/usr/bin/env python3
"""Bounded real HTTPS acceptance: synthetic Auth sessions, no trading API calls."""
import base64
import hashlib
import http.client
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import subprocess
import sys
import uuid
from urllib.parse import urlsplit, parse_qs, urlencode

ROOT=Path('/home/mil/robot-sso-20260919')
STAGE='start'
contexts={host:ssl.create_default_context(cafile=path) for host,path in {
    'auth.vpn':'/home/mil/auth-core/auth-vpn-root-ca.crt',
    'tinvest.robot.vpn':'/home/mil/robot.ti.jsnode/tinvest-vpn-root-ca.crt'}.items()}
parents=[]

def sql(text):
    return subprocess.run(['docker','exec','-i','auth-core-postgres','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d','auth_service'],input=text.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True).stdout.decode().strip()

def request(host,path,method='GET',headers=None,body=None):
    c=http.client.HTTPSConnection(host,timeout=10,context=contexts[host])
    c.sock=contexts[host].wrap_socket(socket.create_connection(('127.0.0.1',443),10),server_hostname=host)
    try:
        c.request(method,path,body=body,headers=headers or {})
        r=c.getresponse();return r.status,r.getheaders(),r.read().decode()
    finally:c.close()

def cookies(headers):
    out=SimpleCookie()
    for k,v in headers:
        if k.lower()=='set-cookie':out.load(v)
    return out

def parent(admin):
    sid=str(uuid.uuid4());token=secrets.token_hex(32);parents.append(sid)
    sql("INSERT INTO auth_sessions(id,user_id,token_id,audience,expires_at) VALUES ('%s','%s','%s','auth-core',now()+interval '5 minutes');"%(sid,admin,hashlib.sha256(token.encode()).hexdigest()))
    return sid,'__Host-auth_session='+token

def login(parent_cookie):
    status,h,_=request('tinvest.robot.vpn','/auth/login');assert status==303
    redirect={k.lower():v for k,v in h}['location'];assert urlsplit(redirect).netloc=='auth.vpn'
    p=parse_qs(urlsplit(redirect).query)
    data={'client_id':'tinvest.robot','redirect_uri':p['redirect_uri'][0],'state':p['state'][0],'code_challenge':p['code_challenge'][0]}
    assert data['redirect_uri']=='https://tinvest.robot.vpn/auth/callback'
    status,_,body=request('auth.vpn','/api/sso/authorize','POST',{'Origin':'https://auth.vpn','Content-Type':'application/json','Cookie':parent_cookie},json.dumps(data))
    assert status==200
    cb=urlsplit(json.loads(body)['redirectUrl']);binding=cookies(h)['__Host-tinvest-login'].value
    status,h,body=request('tinvest.robot.vpn',cb.path+'?'+cb.query,headers={'Cookie':'__Host-tinvest-login='+binding})
    assert status==303
    session=cookies(h)['__Host-tinvest-session']
    raw_cookie=next(v for k,v in h if k.lower()=='set-cookie' and v.startswith('__Host-tinvest-session='))
    assert session['secure'] and session['httponly'] and 'SameSite=Lax' in raw_cookie and session['path']=='/' and not session['domain']
    return '__Host-tinvest-session='+session.value

def main():
    global STAGE
    admin=sql("SELECT id FROM auth_users WHERE primary_identifier='admin' AND status='active';")
    assert str(uuid.UUID(admin))==admin
    membership="UPDATE auth_memberships SET status='%s',updated_at=now() WHERE user_id='"+admin+"' AND service_id=(SELECT id FROM auth_consumer_services WHERE service_key='tinvest.robot');"
    result={}
    try:
        STAGE='unauthenticated'
        status,_,body=request('tinvest.robot.vpn','/');assert status==200 and 'noopener noreferrer' in body
        assert request('tinvest.robot.vpn','/api/viewer/status')[0]==401
        assert request('tinvest.robot.vpn','/api/status')[0]==401
        result['direct_api_denied']=True
        sid,pc=parent(admin)
        STAGE='login'
        session=login(pc);headers={'Cookie':session}
        status,_,page=request('tinvest.robot.vpn','/viewer',headers=headers);assert status==200
        status,_,body=request('tinvest.robot.vpn','/api/viewer/status',headers=headers);assert status==200 and 'status' in json.loads(body)
        result['https_pkce_login_viewer_cookie']=True
        STAGE='permissions'
        for path in ['/api/admin/account-mode','/api/admin/live-actions','/api/admin/risk-settings','/api/admin/sell-settings','/api/admin/cancel-stale-limit-orders','/api/admin/protective-stops-resync','/api/social-cookies']:
            assert request('tinvest.robot.vpn',path,'POST',dict(headers,Origin='https://tinvest.robot.vpn'), '{}')[0]==403
        for path in ['/api/positions','/api/buy-scan','/api/sell-brain','/api/preview']:
            assert request('tinvest.robot.vpn',path,headers=headers)[0]==403
        result['viewer_operational_routes_denied']=True
        assert request('tinvest.robot.vpn','/auth/logout','POST',headers,'')[0]==403
        result['csrf_denied']=True
        STAGE='parent-revocation'
        sql("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE id='"+sid+"';")
        assert request('tinvest.robot.vpn','/api/viewer/status',headers=headers)[0]==403
        result['parent_revocation']=True
        sid,pc=parent(admin);session=login(pc);headers={'Cookie':session}
        STAGE='membership-revocation'
        sql(membership%'suspended')
        try: assert request('tinvest.robot.vpn','/api/viewer/status',headers=headers)[0]==403
        finally: sql(membership%'active')
        result['membership_revocation']=True
        STAGE='logout'
        session=login(pc);headers={'Cookie':session}
        status,_,page=request('tinvest.robot.vpn','/viewer',headers=headers);assert status==200
        csrf=re.search(r'name="csrf" value="([^"]+)"',page).group(1)
        status,_,body=request('tinvest.robot.vpn','/auth/logout','POST',dict(headers,Origin='https://tinvest.robot.vpn',**{'Content-Type':'application/x-www-form-urlencoded'}),urlencode({'csrf':csrf}))
        assert status==200 and json.loads(body)['remoteRevoked'] is True
        assert request('tinvest.robot.vpn','/viewer',headers=headers)[0]==401
        result['logout_remote_revoke']=True
        STAGE='legacy-and-safety'
        d=json.loads(subprocess.check_output(['docker','inspect','robot_ti_jsnode']))[0]
        e=dict(v.split('=',1) for v in d['Config']['Env'] if '=' in v)
        basic=base64.b64encode(((e.get('ROBOT_WEB_USERNAME') or 'robot')+':'+e['ROBOT_WEB_PASSWORD']).encode()).decode()
        status,_,body=request('tinvest.robot.vpn','/api/status',headers={'Authorization':'Basic '+basic});assert status==200
        status_data=json.loads(body);config=status_data['config']
        assert config['tradingPaused'] is True and config['liveAllowedActions']==['sell']
        assert request('tinvest.robot.vpn','/api/status',headers={'Authorization':'Basic '+basic,'Cookie':session})[0]==401
        result['legacy_basic_separate']=True;result['trading_paused']=True;result['sell_only']=True
        STAGE='catalog'
        sql("UPDATE auth_consumer_services SET metadata=metadata || '{\"integration_ready\":true,\"launch_url\":\"https://tinvest.robot.vpn/auth/login\"}'::jsonb,updated_at=now() WHERE service_key='tinvest.robot';")
        assert sql("SELECT count(*) FROM auth_memberships m JOIN auth_consumer_services s ON s.id=m.service_id WHERE s.service_key='tinvest.robot' AND m.status='active';")=='1'
        result['admin_only']=True;result['catalog_ready']=True;result['password_login_tested']=False
        (ROOT/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result))
    finally:
        for sid in parents:sql("DELETE FROM auth_sessions WHERE id='"+sid+"';")

if __name__=='__main__':
    os.umask(0o077)
    try:main()
    except Exception as error:
        import traceback
        print(json.dumps({'ok':False,'stage':STAGE,'error_type':type(error).__name__,'line':traceback.extract_tb(error.__traceback__)[-1].lineno}));sys.exit(1)
