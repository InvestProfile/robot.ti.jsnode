# Runbook

## Local checks

```bash
npm test
npm run lint
```

The UI build updates tracked `public/` files. For backend-only checks, an isolated
source copy can keep those generated changes out of the working tree. Avoid
repeated API-heavy reports during trading hours.

## Production inventory

Verified on 2026-09-18:

- Use SSH alias `hyperion-trading` from Athena. It selects the project-specific
  key and remote user; bare `ssh igorjan94.ru` does not select that profile.
- `/home/mil/robot.ti.jsnode` is not a Git repository and is not the running
  robot's source mount. The social collector still uses that directory.
- The robot runs from a separate release mounted read-only at `/code`.
- Active safety release:
  `/home/mil/releases/robot-ti-safety-42f5457`.
- Compose file:
  `/home/mil/robot.ti.jsnode/docker-compose.robot-safety-42f5457.yml`.
- The robot's separate writable environment mount is `/run/robot-env`.
- Preserve `ROBOT_LIVE_ALLOWED_ACTIONS=sell` and the existing shadow-outbox
  setting. `ROBOT_TRADING_PAUSED=true` carries forward the pre-deploy open
  circuit breaker across process restart; do not clear this pause implicitly.

Inspect actual mounts and the effective API configuration before each deploy.
Do not recreate the robot with the old default Compose file: that can restore
an older source tree and different trading/environment settings.

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 hyperion-trading \
  'docker ps --filter name=robot_ti --format "{{.Names}} {{.Status}}"'
```

## Archive-based release deployment

1. Select and document a reviewed Git commit or a verified production base plus
   an explicit list of safety-file overlays. The September repair uses base
   `d2cbd7d` plus the trading safety files from `42f5457`; unrelated later
   Paper/Margin work is not implicitly activated or deployed.
2. Create a new directory under `/home/mil/releases` and extract `git archive`
   there. Never extract over a running immutable release. Do not copy `.env`
   into the release or back into the development repository.
3. Validate the exact assembled release in a temporary Node container with its
   directory writable and the existing dependency volume mounted. Run `npm test`
   and `npm run lint` without production environment variables. Supply dummy
   model-constructor settings: `DB_NAME=robot_test DB_USER=robot_test
   DB_HOST=127.0.0.1 DB_PORT=1 DB_DIALECT=postgres`. Tests mock persistence;
   these values do not grant database access. Preserve logs
   outside the release. Do not run `npm ci` against the shared live dependency
   volume as part of this check.
4. Copy the active robot-specific Compose file to a new versioned file and
   change only the reviewed release mount and explicitly required safety state.
   Keep the dependency/environment mounts, ports, shadow configuration, and
   sell-only policy. A restart clears an in-memory circuit breaker, so first
   inspect it and preserve any existing trading block with an explicit pause.
5. Only after checks pass, recreate **robot only**, using the matching file and
   the existing Compose project name:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 hyperion-trading \
  'docker-compose -p robottijsnode \
    -f /home/mil/robot.ti.jsnode/docker-compose.robot-safety-42f5457.yml \
    up -d --no-deps --force-recreate robot'
```

6. Authenticate to the dashboard using credentials loaded inside the container,
   never printed or passed in shell arguments. Check `/api/health`, `/api/status`,
   and `/api/order-safety`; verify the actual mounted release and at least one
   completed post-restart tick. Confirm no unintended trades or policy changes.

## Rollback

Retain the prior release and Compose file. Before rollback, copy the prior file
into a rollback-specific file and preserve the **current** trading pause and
sell-only policy. Then recreate only the robot using that reviewed file. Never
blindly use an old Compose file that would re-enable trading.

For accounting repair rollback, see [[ACCOUNTING_AUDIT_2026-09-18]]. A code
rollback does not roll back database corrections.

## Logs and restart

Read logs through `hyperion-trading`; inspect only necessary errors and avoid
printing credentials or cookie contents. A restart resets process-local safety
state and must receive the same mode/breaker checks as deployment. The social
collector does not require restarting for changes to order accounting.
