#!/usr/bin/env python3
"""Scoped owner access deployment. Pinned subject arrives on stdin, never from login lookup."""
import base64
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import time
import uuid
import yaml

ROOT = Path('/home/mil/robot-sso-20260920')
APP = Path('/home/mil/robot.ti.jsnode')
OLD = Path('/home/mil/releases/robot-ti-viewer-b69d1a8')
NEW = Path('/home/mil/releases/robot-ti-access-4c0265b')
PREVIOUS = APP / 'docker-compose.robot-viewer-b69d1a8.yml'
COMPOSE = APP / 'docker-compose.robot-access-4c0265b.yml'
GRANT = APP / 'runtime-env/auth-operator-4c0265b.env'
BACKUP = ROOT / 'access-4c0265b-backup'

def run(*args, data=None):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180).stdout

def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]

def membership(subject):
    statement = "BEGIN READ ONLY; SELECT count(*) FROM auth_users u JOIN auth_memberships m ON m.user_id=u.id JOIN auth_consumer_services s ON s.id=m.service_id WHERE u.id='%s' AND u.status='active' AND m.status='active' AND s.service_key='tinvest.robot' AND s.status='active'; COMMIT;" % subject
    return '1' in run('docker', 'exec', '-i', 'auth-core-postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'auth_service', data=statement.encode()).decode().splitlines()

def request(path, headers=None):
    ctx = ssl.create_default_context(cafile=str(APP / 'tinvest-vpn-root-ca.crt'))
    c = http.client.HTTPSConnection('tinvest.robot.vpn', timeout=10, context=ctx)
    c.sock = ctx.wrap_socket(socket.create_connection(('127.0.0.1', 443), 10), server_hostname='tinvest.robot.vpn')
    try:
        c.request('GET', path, headers=headers or {})
        r = c.getresponse()
        return r.status, dict((k.lower(), v) for k, v in r.getheaders()), r.read()
    finally:
        c.close()

def write(path, text):
    with path.open('x') as f:
        f.write(text)
    path.chmod(0o600)

def main():
    os.umask(0o077)
    subject = json.load(sys.stdin)['subject']
    assert str(uuid.UUID(subject)) == subject
    before = inspect('robot_ti_jsnode')
    env = dict(v.split('=', 1) for v in before['Config']['Env'])
    assert env['ROBOT_AUTH_VIEWER_SUBJECTS'].split(',') == [subject] and not env.get('ROBOT_AUTH_OPERATOR_SUBJECTS')
    assert membership(subject)
    assert env['ROBOT_TRADING_PAUSED'] == 'true' and env['ROBOT_LIVE_ALLOWED_ACTIONS'] == 'sell'
    assert any(m['Source'] == str(OLD) and m['Destination'] == '/code' and not m['RW'] for m in before['Mounts'])
    assert NEW.is_dir() and not COMPOSE.exists() and not GRANT.exists() and not BACKUP.exists()
    basic = 'Basic ' + base64.b64encode(((env.get('ROBOT_WEB_USERNAME') or 'robot') + ':' + env['ROBOT_WEB_PASSWORD']).encode()).decode()
    status, _, body = request('/api/status', {'Authorization': basic})
    assert status == 200
    config = json.loads(body)['config']
    assert config['tradingPaused'] is True and config['liveAllowedActions'] == ['sell']
    peers = {n: inspect(n)['Id'] for n in ['robot_ti_virtual_observation', 'robot_ti_social_collector', 'pg-tink-robot']}
    BACKUP.mkdir(mode=0o700)
    shutil.copy2(str(PREVIOUS), str(BACKUP / 'compose.yml'))
    write(BACKUP / 'safe-config.json', json.dumps(config))
    write(GRANT, 'ROBOT_AUTH_OPERATOR_SUBJECTS=' + subject + '\n')
    d = yaml.safe_load(PREVIOUS.read_text())
    robot = d['services']['robot']
    assert isinstance(robot['env_file'], list)
    robot['env_file'] = robot['env_file'] + [str(GRANT)]
    assert sum(str(OLD) + ':' in v for v in robot['volumes']) == 1
    robot['volumes'] = [v.replace(str(OLD) + ':', str(NEW) + ':') for v in robot['volumes']]
    write(COMPOSE, yaml.safe_dump(d, default_flow_style=False))
    run('docker-compose', '-p', 'robottijsnode', '-f', str(COMPOSE), 'config', '--quiet')
    assert inspect('robot_ti_jsnode')['Id'] == before['Id']
    run('docker-compose', '-p', 'robottijsnode', '-f', str(COMPOSE), 'up', '-d', '--no-deps', '--force-recreate', 'robot')
    after = inspect('robot_ti_jsnode')
    actual = dict(v.split('=', 1) for v in after['Config']['Env'])
    assert actual.pop('ROBOT_AUTH_OPERATOR_SUBJECTS') == subject and actual == env
    assert after['Image'] == before['Image'] and after['HostConfig']['PortBindings'] == before['HostConfig']['PortBindings']
    assert all(inspect(n)['Id'] == value for n, value in peers.items())
    for _ in range(60):
        try:
            status, _, body = request('/api/status', {'Authorization': basic})
            if status == 200:
                break
        except OSError:
            pass
        time.sleep(1)
    else:
        raise RuntimeError('readiness timeout')
    current = json.loads(body)
    assert current['config'] == config
    assert not current['runtime'].get('lastTickStartedAt') and not current['runtime'].get('isTickRunning')
    for endpoint in ['/', '/viewer']:
        code, headers, _ = request(endpoint)
        assert code == 303 and headers.get('location') == '/auth/login' and 'www-authenticate' not in headers
    for endpoint in ['/api/status', '/api/accounts', '/api/positions', '/auth/session']:
        code, headers, _ = request(endpoint)
        assert code == 401 and 'location' not in headers
    code, _, body = request('/auth/session', {'Authorization': basic})
    assert code == 200 and json.loads(body) == {'access': 'basic'}
    assert request('/api/status', {'Authorization': basic, 'Cookie': '__Host-tinvest-session=invalid'})[0] == 401
    assert membership(subject)
    result = {'ok': True, 'release': str(NEW), 'compose': str(COMPOSE), 'started_at': after['State']['StartedAt'],
              'pinned_owner_grant': True, 'membership_preserved': True, 'only_operator_grant_added_to_env': True,
              'all_effective_config_unchanged': True, 'pause': True, 'sell_only': True, 'trading_tick_not_started': True,
              'peers_unchanged': True, 'anonymous_redirects': True, 'api401': True, 'basic_separate': True,
              'invalid_cookie_no_basic_fallback': True, 'backup': str(BACKUP)}
    write(ROOT / 'access-4c0265b-verification.json', json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        # Never print env, subprocess stderr or the private owner UUID.
        import traceback
        print(json.dumps({'ok': False, 'error_type': type(e).__name__, 'line': traceback.extract_tb(e.__traceback__)[-1].lineno}))
        sys.exit(1)
