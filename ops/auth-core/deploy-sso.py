#!/usr/bin/env python3
"""Fixed Hyperion T-Invest SSO rollout; values stay in protected remote files."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import uuid
import yaml

ROOT = Path('/home/mil/robot-sso-20260919')
AUTH = Path('/home/mil/auth-core')
ROBOT = Path('/home/mil/robot.ti.jsnode')
RELEASE = Path('/home/mil/releases/robot-ti-sso-b2581b9')
COMPOSE = ROBOT / 'docker-compose.robot-sso-b2581b9.yml'
OLD_COMPOSE = ROBOT / 'docker-compose.robot-safety-42f5457.yml'
IMAGE = 'auth-core:multi-service-sso-9003f5f-20260919'
CANDIDATE = 'auth-core-tinvest-candidate-20260919'
BACKUP = 'auth-core-before-tinvest-20260919'
STAGE = 'preflight'

def run(*args, data=None, timeout=120):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=timeout).stdout

def sql(text):
    return run('docker', 'exec', '-i', 'auth-core-postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'auth_service', data=text.encode()).decode().strip()

def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]

def write(path, text):
    with path.open('x') as f: f.write(text)
    path.chmod(0o600)

def status(port, path='/readyz'):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    try:
        c.request('GET', path)
        r = c.getresponse(); r.read(); return r.status
    finally: c.close()

def ready(port):
    for _ in range(20):
        try:
            if status(port) == 200: return
        except OSError: pass
        time.sleep(1)
    raise RuntimeError('readiness failed')

def create(name, port):
    run('docker', 'create', '--name', name, '--restart', 'unless-stopped', '--network', 'auth-core-web', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '384m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '--env-file', str(AUTH / 'runtime/app.env'), '-p', '127.0.0.1:%d:3000' % port, IMAGE)
    run('docker', 'network', 'connect', 'auth-core-private', name)

def main():
    global STAGE
    os.umask(0o077)
    old = inspect('auth-core'); robot = inspect('robot_ti_jsnode')
    if old['Image'] != 'sha256:59ac0f2494cda32eb8d5f09d2e97e18b73f6c41c3d74083fe982e4efb28dd266': raise RuntimeError('Auth baseline changed')
    if old['Mounts'] or set(old['NetworkSettings']['Networks']) != {'auth-core-web','auth-core-private'}: raise RuntimeError('Auth layout changed')
    if robot['Id'] != '3153658d89dd3dd64a7f5640949802a96bd76243df57efc7a81f19acfca21938': raise RuntimeError('Robot baseline changed')
    if '192.168.5.3' != robot['NetworkSettings']['Networks']['robottijsnode_default']['IPAddress']: raise RuntimeError('Robot IP changed')
    if COMPOSE.exists() or (ROOT / 'backup').exists(): raise RuntimeError('Rollout already prepared')
    if shutil.disk_usage(ROOT).free < 700 * 1024**2: raise RuntimeError('Insufficient disk')
    admin = sql("SELECT id FROM auth_users WHERE primary_identifier='admin' AND status='active';")
    if str(uuid.UUID(admin)) != admin: raise RuntimeError('Admin identity invalid')
    unexpected = sql("SELECT count(*) FROM auth_memberships m JOIN auth_consumer_services s ON s.id=m.service_id WHERE s.service_key='tinvest.robot' AND m.user_id <> '"+admin+"';")
    if unexpected != '0': raise RuntimeError('Unexpected existing members; do not overwrite')
    STAGE = 'backup'
    backup = ROOT / 'backup'; backup.mkdir(mode=0o700)
    db_backup = json.loads(run('python3', str(AUTH / 'backup-database.py')))
    if not db_backup.get('ok'): raise RuntimeError('Backup failed')
    shutil.copy2(AUTH / 'runtime/app.env', backup / 'auth-app.env')
    shutil.copy2(OLD_COMPOSE, backup / 'robot-compose.yml')
    write(backup / 'service-before.json', sql("SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT * FROM auth_consumer_services WHERE service_key='tinvest.robot') t;"))
    write(backup / 'membership-before.json', sql("SELECT coalesce(json_agg(m),'[]'::json) FROM auth_memberships m JOIN auth_consumer_services s ON s.id=m.service_id WHERE s.service_key='tinvest.robot';"))
    env_text = (AUTH / 'runtime/app.env').read_text()
    if 'AUTH_TINVEST_' in env_text: raise RuntimeError('Client config already exists')
    client_secret = secrets.token_urlsafe(48)
    # No secret is passed in argv or printed. Existing values/credentials are retained.
    with (AUTH / 'runtime/app.env').open('a') as f:
        f.write('\nAUTH_TINVEST_SECRET='+client_secret+'\nAUTH_TINVEST_CALLBACK=https://tinvest.robot.vpn/auth/callback\n')
    (AUTH / 'runtime/app.env').chmod(0o600)
    write(ROBOT / 'runtime-env/auth-core.env', 'ROBOT_AUTH_ORIGIN=https://auth.vpn\nROBOT_AUTH_CONSUMER_ORIGIN=https://tinvest.robot.vpn\nROBOT_AUTH_SECRET='+client_secret+'\nROBOT_AUTH_VIEWER_SUBJECTS='+admin+'\n')
    del client_secret
    STAGE = 'auth-build'
    dockerfile = 'FROM '+old['Image']+'\nCOPY --chown=node:node main.mjs sso-clients.mjs /app/server/\n'
    run('docker', 'build', '-t', IMAGE, '-f', '-', str(ROOT / 'auth'), data=dockerfile.encode(), timeout=180)
    STAGE = 'candidate'
    create(CANDIDATE, 5761)
    try:
        run('docker', 'start', CANDIDATE); ready(5761)
        if status(5761, '/api/account') != 401: raise RuntimeError('Candidate access check failed')
    finally:
        run('docker', 'rm', '-f', CANDIDATE)
    STAGE = 'membership'
    # Existing service metadata is retained; only this service/admin membership changes.
    statement = """BEGIN;
    INSERT INTO auth_consumer_services(id,service_key,display_name,status)
    VALUES ('%s','tinvest.robot','T-Invest Robot','active')
    ON CONFLICT(service_key) DO UPDATE SET status='active',updated_at=now();
    INSERT INTO auth_memberships(id,user_id,service_id,status,created_by,updated_by)
    SELECT '%s','%s',id,'active','%s','%s' FROM auth_consumer_services WHERE service_key='tinvest.robot'
    ON CONFLICT(user_id,service_id) DO UPDATE SET status='active',updated_by=EXCLUDED.updated_by,updated_at=now();
    COMMIT;""" % (uuid.uuid4(),uuid.uuid4(),admin,admin,admin)
    sql(statement)
    STAGE = 'auth-switch'
    if inspect('auth-core')['Id'] != old['Id']: raise RuntimeError('Concurrent Auth change')
    create('auth-core-tinvest-next-20260919', 5760)
    renamed = False; promoted = False
    try:
        run('docker','stop','auth-core'); run('docker','rename','auth-core',BACKUP); renamed=True
        run('docker','rename','auth-core-tinvest-next-20260919','auth-core'); promoted=True
        run('docker','start','auth-core'); ready(5760)
    except Exception:
        if promoted: run('docker','rm','-f','auth-core')
        if renamed: run('docker','rename',BACKUP,'auth-core'); run('docker','start','auth-core')
        raise
    STAGE = 'robot-config'
    d = yaml.safe_load(OLD_COMPOSE.read_text()); r=d['services']['robot']
    r['volumes']=[v.replace('/home/mil/releases/robot-ti-safety-42f5457:',str(RELEASE)+':') for v in r['volumes']]
    r['env_file']=[r['env_file'],str(ROBOT / 'runtime-env/auth-core.env')]
    # Pin only the server backchannel to the host bridge; dashboard DNS remains VPN-owned.
    r['extra_hosts']=['auth.vpn:192.168.5.1']
    r['networks']={'default':{'ipv4_address':'192.168.5.3'}}
    # Use the existing network and preserve DB/social/worker connectivity.
    d['networks']={'default':{'external':{'name':'robottijsnode_default'}}}
    r['ports']=['127.0.0.1:5757:3000']
    r['environment']['ROBOT_TRADING_PAUSED']='true'
    r['environment']['ROBOT_LIVE_ALLOWED_ACTIONS']='sell'
    ca = (RELEASE / 'certs/russian_trusted_root_ca_pem.crt').read_text()+'\n'+(AUTH / 'auth-vpn-root-ca.crt').read_text()
    write(ROBOT / 'runtime-env/auth-ca-bundle.crt',ca)
    r['environment']['NODE_EXTRA_CA_CERTS']='/run/robot-env/auth-ca-bundle.crt'
    write(COMPOSE,yaml.safe_dump(d,default_flow_style=False))
    run('docker-compose','-p','robottijsnode','-f',str(COMPOSE),'config','--quiet')
    result={'ok':True,'phase':'prepared-auth-live-robot-not-switched','auth_image':IMAGE,'auth_rollback':BACKUP,'db_backup':db_backup['backup'],'robot_compose':str(COMPOSE),'robot_release':str(RELEASE),'admin_only':True}
    write(ROOT / 'prepared.json',json.dumps(result)+'\n');print(json.dumps(result))

if __name__=='__main__':
    try: main()
    except Exception:
        print(json.dumps({'ok':False,'stage':STAGE,'error':'deployment-step-failed; inspect protected evidence without printing secrets'}));sys.exit(1)
