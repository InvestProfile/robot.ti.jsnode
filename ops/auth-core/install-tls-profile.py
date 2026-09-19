#!/usr/bin/python3 -I
"""Install the fixed T-Invest TLS profile using metadata only."""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess

def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    source = Path(__file__).resolve().parent
    registry = Path('/etc/agent-secrets/athena-registry.json')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = Path('/var/lib/agent-secrets-broker/backups') / ('tinvest-tls-' + stamp)
    backup.mkdir(mode=0o700)
    shutil.copy2(registry, backup / 'registry.before.json')
    ref = 'secret://inbox/web-20260904t230513z-hlpfublwbctp'
    destination = 'hyperion.tinvest-tls'
    profile = 'hyperion-tinvest-tls-deploy'
    original = registry.read_bytes()
    data = json.loads(original)
    if data['secrets'][ref]['status'] != 'active':
        raise RuntimeError('secret is inactive')
    if profile in data['profiles']:
        raise RuntimeError('profile already exists; review before replacement')
    for name, installed in [('tinvest-tls-bridge.py', 'tinvest-tls-bridge.py'), ('tinvest-tls-remote.py', 'tinvest-tls-remote.py')]:
        target = Path('/usr/local/libexec') / installed
        if target.exists() or target.is_symlink():
            raise RuntimeError('helper path occupied')
        shutil.copyfile(source / name, target)
        target.chmod(0o755)
    sudoers = Path('/etc/sudoers.d/97-tinvest-tls-deploy')
    if sudoers.exists():
        raise RuntimeError('sudoers path occupied')
    sudoers.write_text('anton ALL=(root) NOPASSWD: /usr/local/libexec/tinvest-tls-bridge.py --server\n')
    sudoers.chmod(0o440)
    subprocess.run(['/usr/sbin/visudo', '-cf', str(sudoers)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if destination not in data['secrets'][ref]['destinations']:
        data['secrets'][ref]['destinations'].append(destination)
    data['profiles'][profile] = {
        'allowed_destinations': [destination], 'allowed_refs': [ref],
        'arguments': ['--consumer', '--destination', '{destination}'],
        'executable': '/usr/local/libexec/tinvest-tls-bridge.py',
        'injection': 'stdin', 'timeout_seconds': 120,
    }
    stage = registry.with_name('athena-registry.tinvest-stage.json')
    if stage.exists():
        raise RuntimeError('registry stage occupied')
    stage.write_text(json.dumps(data, indent=2) + '\n')
    stage.chmod(0o600)
    stat = registry.stat()
    os.chown(stage, stat.st_uid, stat.st_gid)
    if registry.read_bytes() != original:
        stage.unlink()
        raise RuntimeError('registry changed concurrently; no registry update applied')
    stage.replace(registry)
    try:
        subprocess.run(['systemctl', 'restart', 'agent-secrets-broker@athena.service'], check=True)
        subprocess.run(['systemctl', 'is-active', '--quiet', 'agent-secrets-broker@athena.service'], check=True)
    except Exception:
        shutil.copy2(backup / 'registry.before.json', registry)
        subprocess.run(['systemctl', 'restart', 'agent-secrets-broker@athena.service'], check=False)
        raise
    print(json.dumps({'ok': True, 'backup': str(backup), 'profile': profile}))

if __name__ == '__main__':
    os.umask(0o077)
    main()
