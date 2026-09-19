#!/usr/bin/python3 -I
"""Fixed Hyperion tinvest.robot.vpn TLS deployment and certificate renewal."""
import datetime
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

TLS = Path('/etc/tinvest/tls')
SITE = Path('/etc/nginx/sites-available/tinvest.robot.vpn')
ENABLED = Path('/etc/nginx/sites-enabled/tinvest.robot.vpn')
AUTH_SITE = Path('/etc/nginx/sites-available/auth.vpn')
ALLOW = ['157.22.184.131', '185.9.27.65', '77.238.234.74', '38.54.13.221', '127.0.0.1', '::1']

def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

def write(path, text, mode=0o644):
    path = Path(path)
    temp = path.with_name(path.name + '.tinvest-new')
    if temp.exists() or temp.is_symlink():
        raise RuntimeError('staging path occupied')
    with temp.open('x') as handle:
        handle.write(text)
    temp.chmod(mode)
    temp.replace(path)

def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    os.umask(0o077)
    renew = sys.argv[1:] == ['--renew']
    if sys.argv[1:] and not renew:
        raise RuntimeError('unsupported arguments')
    if renew and subprocess.run(['openssl', 'x509', '-checkend', '2592000', '-noout', '-in', str(TLS / 'server.crt')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = Path('/root/tinvest-backups') / stamp
    backup.mkdir(parents=True, mode=0o700)
    if TLS.exists():
        shutil.copytree(TLS, backup / 'tls')
    for path in [SITE, ENABLED]:
        if path.exists() or path.is_symlink():
            if path == ENABLED:
                if not path.is_symlink() or path.resolve() != SITE:
                    raise RuntimeError('unexpected existing tinvest.robot.vpn enabled entry')
            else:
                if path.is_symlink():
                    raise RuntimeError('unexpected site symlink')
                shutil.copy2(path, backup / 'nginx.before')
    old_enabled = ENABLED.is_symlink()
    if not renew:
        if AUTH_SITE.is_symlink():
            raise RuntimeError('unexpected Auth site symlink')
        shutil.copy2(AUTH_SITE, backup / 'auth-nginx.before')
    if not renew:
        existing = SITE.read_text()
        expected = {'157.22.184.131', '38.54.13.221', '185.9.27.65', '127.0.0.1'}
        if set(re.findall(r'allow\s+([^;]+);', existing)) != expected or 'deny all;' not in existing:
            raise RuntimeError('unexpected VPN ACL; manual review required')
    TLS.mkdir(parents=True, exist_ok=True, mode=0o700)
    TLS.chmod(0o700)
    ca_key = TLS / 'ca.key'
    ca_cert = TLS / 'ca.crt'
    if not ca_key.exists():
        if renew or ca_cert.exists():
            raise RuntimeError('existing CA key unavailable')
        run('openssl', 'genrsa', '-out', str(ca_key), '3072')
    # Explicit config avoids duplicate extensions from the host OpenSSL defaults.
    repair_ca = not ca_cert.exists()
    if ca_cert.exists():
        details = run('openssl', 'x509', '-in', str(ca_cert), '-noout', '-text')
        repair_ca = details.count(b'X509v3 Basic Constraints:') != 1
    if repair_ca:
        write(TLS / 'ca.cnf', '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=T-Invest VPN Root CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:tinvest.robot.vpn\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
        run('openssl', 'req', '-x509', '-new', '-sha256', '-key', str(ca_key),
            '-out', str(ca_cert), '-days', '3650', '-config', str(TLS / 'ca.cnf'))
    stage = TLS / ('stage-' + stamp)
    stage.mkdir(mode=0o700)
    run('openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=tinvest.robot.vpn',
        '-keyout', str(stage / 'server.key'), '-out', str(stage / 'server.csr'))
    write(stage / 'leaf.ext', 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:tinvest.robot.vpn\n')
    run('openssl', 'x509', '-req', '-in', str(stage / 'server.csr'), '-CA', str(TLS / 'ca.crt'),
        '-CAkey', str(TLS / 'ca.key'), '-set_serial', '0x' + os.urandom(16).hex(),
        '-out', str(stage / 'server.crt'), '-days', '90', '-sha256', '-extfile', str(stage / 'leaf.ext'))
    run('openssl', 'verify', '-CAfile', str(TLS / 'ca.crt'), '-verify_hostname', 'tinvest.robot.vpn', str(stage / 'server.crt'))
    for name in ['server.key', 'server.crt']:
        (stage / name).replace(TLS / name)
    shutil.rmtree(stage)
    config = "# T-Invest VPN-only TLS; installed by fixed broker operation.\n# This file is included in nginx's http context. No request/query/header logging.\nlog_format tinvest_safe '$remote_addr $request_method $uri $status $body_bytes_sent';\n\nserver {\n    listen 80;\n    listen [::]:80;\n    server_name tinvest.robot.vpn;\n    allow 157.22.184.131;\n    allow 38.54.13.221;\n    allow 185.9.27.65;\n    allow 127.0.0.1;\n    deny all;\n    access_log /var/log/nginx/tinvest.robot.vpn.access.log tinvest_safe;\n    location ^~ /auth/ {\n        access_log off;\n        error_log /dev/null;\n        return 400;\n    }\n    location / {\n        # Access phase runs before the redirect; unauthorized sources stay denied.\n        try_files /nonexistent-tinvest-redirect @https;\n    }\n    location @https { return 308 https://tinvest.robot.vpn$uri; }\n}\n\nserver {\n    listen 443 ssl;\n    listen [::]:443 ssl;\n    server_name tinvest.robot.vpn;\n    ssl_certificate /etc/tinvest/tls/server.crt;\n    ssl_certificate_key /etc/tinvest/tls/server.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    allow 157.22.184.131;\n    allow 38.54.13.221;\n    allow 185.9.27.65;\n    allow 127.0.0.1;\n    deny all;\n    access_log /var/log/nginx/tinvest.robot.vpn.access.log tinvest_safe;\n    add_header Referrer-Policy no-referrer always;\n    proxy_set_header Host tinvest.robot.vpn;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-Proto https;\n    proxy_http_version 1.1;\n    proxy_read_timeout 15s;\n    location ^~ /auth/ {\n        access_log off;\n        error_log /dev/null;\n        proxy_pass http://127.0.0.1:5757;\n    }\n    location / { proxy_pass http://127.0.0.1:5757; }\n}\n"
    try:
        if not renew:
            auth = AUTH_SITE.read_text()
            if '# T-Invest fixed backchannel' not in auth:
                marker = '    ssl_protocols TLSv1.2 TLSv1.3;'
                if auth.count(marker) != 1:
                    raise RuntimeError('unexpected Auth TLS configuration')
                backchannel = """
    # T-Invest fixed backchannel; existing browser ACL is unchanged.
    location ~ ^/(api/sso/(exchange|introspect|revoke)|healthz)$ {
        allow 192.168.5.3;
        allow 157.22.184.131;
        allow 185.9.27.65;
        allow 77.238.234.74;
        allow 127.0.0.1;
        allow ::1;
        deny all;
        access_log off;
        error_log /dev/null;
        proxy_pass http://127.0.0.1:5760;
        proxy_http_version 1.1;
        proxy_set_header Host auth.vpn;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        proxy_read_timeout 20s;
    }
"""
                auth = auth.replace(marker, marker + backchannel)
                auth = auth.replace('    server_name auth.vpn;', '    server_name auth.vpn;\n    access_log off;\n    error_log /dev/null;')
                write(AUTH_SITE, auth)
            write(SITE, config)
            if not old_enabled:
                ENABLED.symlink_to(SITE)
        run('/usr/sbin/nginx', '-t')
        run('systemctl', 'reload', 'nginx')
    except Exception:
        if (backup / 'tls/server.crt').exists():
            for name in ['server.crt', 'server.key']:
                shutil.copy2(backup / 'tls' / name, TLS / name)
        if not renew:
            shutil.copy2(backup / 'auth-nginx.before', AUTH_SITE)
            if (backup / 'nginx.before').exists():
                shutil.copy2(backup / 'nginx.before', SITE)
            else:
                SITE.unlink() if SITE.exists() else None
            if not old_enabled:
                ENABLED.unlink() if ENABLED.is_symlink() else None
        raise
    public = Path('/home/mil/robot.ti.jsnode/tinvest-vpn-root-ca.crt')
    shutil.copyfile(TLS / 'ca.crt', public)
    public.chmod(0o644)
    if not renew:
        write('/usr/local/sbin/tinvest-tls-maintain', SOURCE, 0o700)
        write('/etc/systemd/system/tinvest-tls-renew.service', '[Unit]\nDescription=Renew tinvest.robot.vpn private TLS certificate\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/tinvest-tls-maintain --renew\n')
        write('/etc/systemd/system/tinvest-tls-renew.timer', '[Unit]\nDescription=Check tinvest.robot.vpn TLS expiry daily\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', '--now', 'tinvest-tls-renew.timer')
    result = {'ok': True, 'backup': str(backup), 'domain': 'tinvest.robot.vpn', 'ca_fingerprint': run('openssl', 'x509', '-in', str(TLS / 'ca.crt'), '-noout', '-fingerprint', '-sha256').decode().strip()}
    write('/home/mil/robot.ti.jsnode/tls-status.json', json.dumps(result) + '\n')
    print(json.dumps(result))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'ok': False, 'error': 'tinvest-tls-operation-failed'}))
        sys.exit(1)
