#!/usr/bin/python3 -I
"""Fixed model-blind T-Invest TLS operation; no arbitrary targets or commands."""
import argparse
import grp
import json
import os
from pathlib import Path
import pwd
import shlex
import socket
import struct
import subprocess
import sys
import time

DESTINATION = 'hyperion.tinvest-tls'
PROFILE = 'hyperion-tinvest-tls-deploy'
REF = 'secret://inbox/web-20260904t230513z-hlpfublwbctp'
SOCKET = '/run/agent-secrets-broker/tinvest-tls.sock'
SELF = '/usr/local/libexec/tinvest-tls-bridge.py'
REMOTE = '/usr/local/libexec/tinvest-tls-remote.py'

def wipe(raw):
    for i in range(len(raw)):
        raw[i] = 0

def receive_exact(connection, size):
    data = bytearray()
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            raise ValueError('truncated frame')
        data.extend(chunk)
    return data

def consumer():
    raw = bytearray(sys.stdin.buffer.read(4097))
    try:
        if not raw or len(raw) > 4096:
            return 65
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(110)
            connection.connect(SOCKET)
            connection.sendall(struct.pack('!I', len(raw)))
            connection.sendall(raw)
            response = bytearray()
            while b'\n' not in response and len(response) < 4096:
                chunk = connection.recv(1024)
                if not chunk:
                    break
                response.extend(chunk)
            return 0 if json.loads(response).get('ok') is True else 66
    finally:
        wipe(raw)

def server():
    if os.geteuid() != 0:
        return 67
    uid = pwd.getpwnam('agent-secrets').pw_uid
    raw = bytearray()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        # An occupied path fails closed instead of replacing another operation.
        listener.bind(SOCKET)
        try:
            os.chown(SOCKET, uid, grp.getgrnam('agent-secrets-clients').gr_gid)
            os.chmod(SOCKET, 0o660)
            listener.listen(1)
            listener.settimeout(45)
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(110)
                _, peer_uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if peer_uid != uid:
                    return 68
                size = struct.unpack('!I', receive_exact(connection, 4))[0]
                if not 0 < size <= 4096:
                    return 69
                raw = receive_exact(connection, size)
                if b'\n' in raw or b'\r' in raw or b'\0' in raw:
                    return 70
                info = os.stat(REMOTE, follow_symlinks=False)
                if info.st_uid != 0 or info.st_mode & 0o022 or Path(REMOTE).is_symlink():
                    return 71
                source = Path(REMOTE).read_text()
                code = 'SOURCE = ' + repr(source) + '\n' + source
                command = "/usr/bin/sudo -k -S -p '' /usr/bin/python3 -c " + shlex.quote(code)
                result = subprocess.run(['/usr/bin/sudo', '-n', '-u', 'anton', '/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', 'hyperion-trading', command], input=bytes(raw) + b'\n', stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=100, check=False)
                status = {'ok': result.returncode == 0, 'exit_code': result.returncode}
                connection.sendall((json.dumps(status) + '\n').encode())
                return 0 if status['ok'] else 72
        finally:
            wipe(raw)
            os.unlink(SOCKET)

def launch():
    if Path(SOCKET).exists():
        raise RuntimeError('operation already active')
    helper = subprocess.Popen(['/usr/bin/sudo', '-n', SELF, '--server'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            if helper.poll() is not None:
                raise RuntimeError('bridge failed to start')
            if Path(SOCKET).exists():
                break
            time.sleep(0.05)
        else:
            raise RuntimeError('bridge timeout')
        result = subprocess.run(['/usr/local/bin/secretctl', 'use', '--socket', '/run/agent-secrets-broker/athena.sock', '--ref', REF, '--destination', DESTINATION, '--profile', PROFILE], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120)
        payload = json.loads(result.stdout) if result.stdout else {'ok': False}
        print(json.dumps(payload))
        helper.wait(timeout=10)
        return 0 if payload.get('ok') is True else 1
    finally:
        if helper.poll() is None:
            helper.terminate()
            helper.wait(timeout=5)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--consumer', action='store_true')
    mode.add_argument('--server', action='store_true')
    mode.add_argument('--run', action='store_true')
    parser.add_argument('--destination')
    args = parser.parse_args()
    if args.consumer and args.destination != DESTINATION:
        return 64
    if not args.consumer and args.destination:
        return 64
    return consumer() if args.consumer else server() if args.server else launch()

if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main())
    except Exception:
        print('{"ok":false,"error":"fixed-operation-failed"}')
        sys.exit(1)
