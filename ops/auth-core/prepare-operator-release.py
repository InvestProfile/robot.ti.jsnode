#!/usr/bin/env python3
"""Apply only the reviewed access integration to the pinned safety production base."""
from pathlib import Path
import shutil
import sys

stage, old, new = map(Path, sys.argv[1:])
assert old.name == 'robot-ti-viewer-b69d1a8' and not new.exists()
shutil.copytree(str(old), str(new), symlinks=True)
for name in ['auth-core.ts', 'auth-core.test.ts', 'operator-access.ts', 'operator-integration.test.ts', 'operator-startup.test.ts']:
    shutil.copyfile(str(stage / 'app/http' / name), str(new / 'app/http' / name))
for name in ['auth-session.js', 'auth-session.jsx']:
    shutil.copyfile(str(stage / 'ui/src' / name), str(new / 'ui/src' / name))

def replace(file, before, after, count=1):
    p = new / file
    text = p.read_text()
    assert text.count(before) == count, 'Unexpected baseline: ' + file
    p.write_text(text.replace(before, after))

replace('app/index.ts', '    tradingProcess = startTradingProcess(config);',
        "    if (!config.tradingPaused) tradingProcess = startTradingProcess(config);\n    else console.log('Trading process remains stopped while ROBOT_TRADING_PAUSED is active.');")
replace('app/http/readonly-server.ts', 'const requireAuth = (req: IncomingMessage, res: ServerResponse) => {\n    if (isAuthorized(req))',
        'const requireAuth = (req: IncomingMessage, res: ServerResponse, authCore?: AuthCoreAdapter) => {\n    if (authCore?.isOperatorRequest(req) || isAuthorized(req))')
replace('app/http/readonly-server.ts', '!requireAuth(req, res)', '!requireAuth(req, res, authCore)', 2)
replace('app/http/readonly-server.ts', "    if (req.method === 'POST' && url.pathname === '/api/social-cookies') {",
        "    if (req.method === 'GET' && url.pathname === '/auth/session') {\n        json(res, 200, { access: 'basic' });\n        return;\n    }\n\n    if (req.method === 'POST' && url.pathname === '/api/social-cookies') {")
replace('app/http/readonly-server.ts', "'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'", "'cache-control': 'no-store'")
replace('app/http/readonly-server.ts', 'const warmPreviewCache = async () => {\n    try {', 'const warmPreviewCache = async () => {\n    if (getRobotConfig().tradingPaused) return;\n    try {')
replace('ui/src/main.jsx', "import './styles.css';", "import './styles.css';\nimport { sessionFetch } from './auth-session.js';\nimport { AuthSessionBoundary } from './auth-session.jsx';")
p = new / 'ui/src/main.jsx'
text = p.read_text()
assert text.count('await fetch(') >= 10
p.write_text(text.replace('await fetch(', 'await sessionFetch('))
replace('ui/src/main.jsx', '.render(<App />);', '.render(<AuthSessionBoundary><App /></AuthSessionBoundary>);')
with (new / 'ui/src/styles.css').open('a') as f:
    f.write('\n.sso-session-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--line); background: var(--surface); font-size: 13px; color: var(--muted-strong); }\n.sso-session-bar button { margin-left: auto; }\n')
print('Prepared scoped access overlay on pinned safety base')
