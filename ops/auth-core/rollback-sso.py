#!/usr/bin/env python3
"""Explicit T-Invest-only rollback; retain TLS, loopback ports and trade pause."""
import json
from pathlib import Path
import subprocess
import yaml

ROOT=Path('/home/mil/robot.ti.jsnode')
CURRENT=ROOT/'docker-compose.robot-sso-b2581b9.yml'
ROLLBACK=ROOT/'docker-compose.robot-sso-rollback-20260919.yml'

def main():
    if ROLLBACK.exists(): raise RuntimeError('Review existing rollback file')
    d=yaml.safe_load(CURRENT.read_text());r=d['services']['robot']
    r['volumes']=[v.replace('/home/mil/releases/robot-ti-sso-b2581b9:', '/home/mil/releases/robot-ti-safety-42f5457:') for v in r['volumes']]
    r['env_file']=[p for p in r['env_file'] if p!=str(ROOT/'runtime-env/auth-core.env')]
    r['environment']['ROBOT_TRADING_PAUSED']='true';r['environment']['ROBOT_LIVE_ALLOWED_ACTIONS']='sell'
    assert r['ports']==['127.0.0.1:5757:3000']
    with ROLLBACK.open('x') as f:f.write(yaml.safe_dump(d,default_flow_style=False))
    ROLLBACK.chmod(0o600)
    subprocess.run(['docker-compose','-p','robottijsnode','-f',str(ROLLBACK),'config','--quiet'],check=True)
    sql="""BEGIN;
    UPDATE auth_sso_sessions SET revoked_at=now() WHERE client_id='tinvest.robot' AND revoked_at IS NULL;
    UPDATE auth_consumer_services SET metadata=metadata || '{"integration_ready":false}'::jsonb,updated_at=now() WHERE service_key='tinvest.robot';
    COMMIT;"""
    subprocess.run(['docker','exec','-i','auth-core-postgres','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d','auth_service'],input=sql.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
    subprocess.run(['docker-compose','-p','robottijsnode','-f',str(ROLLBACK),'up','-d','--no-deps','--force-recreate','robot'],check=True)
    print(json.dumps({'ok':True,'consumer_rolled_back':True,'auth_clients_preserved':True,'verify_basic_pause_sell_only_required':True}))

if __name__=='__main__':main()
