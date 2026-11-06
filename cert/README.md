# Certification harness

The certification scripts exercise disposable local services, not a production deployment. They can mutate test databases and create meetings/accounts. Use fresh random credentials and a unique Compose project and container name for each run. Never point them at production services or production databases.

`run-cert.mjs` runs the functional certification suite. `run-security.mjs` runs the automated security controls and writes `SECURITY_EVIDENCE.json` and `SECURITY_EVIDENCE.md`. Both runners record the current Git revision and whether the source tree is dirty.

## Security test stack

Required environment values for `stack-up.ps1` and `run-security.mjs`:

- Fresh `MAIN_DB_PASSWORD`, `QORLLA_APP_DB_PASSWORD`, `MEET_APP_DB_PASSWORD`, `QORLLA_BRIDGE_SECRET`, `JWT_SECRET`, `RECOVERY_ESCROW_KEY`, `QORLLA_VAULT_KEY`, and `ENCRYPT_KEY`.
- Unique `MAIN_HOST_PORT`, `MEET_DB_HOST_PORT`, `MAIN_CONTAINER_NAME`, `MEET_DB_CONTAINER_NAME`, and `MEET_SYNC_CONTAINER_NAME`.
- `MEET_OWNER_DB_URL`, `MEET_APP_DB_URL`, `MAIN_URL`, `MEET_URL`, and `MAIN_DB_CONTAINER_NAME` for the runner. `MEET_OWNER_DB_URL` uses the disposable owner account; `MEET_APP_DB_URL` must use the least-privilege `qorlla_meet_app` role and the same password as `MEET_APP_DB_PASSWORD`.
- Set `MEET_URL` and `MAIN_URL` to the actual loopback ports for the disposable services. The runner uses these settings for browser tests and its local Meet process.
- `SECURITY_LOG_DIR` may point to a temporary directory to keep runtime logs out of the repository. Evidence output defaults to `cert/`.

Generate secret values with a cryptographically secure random-number generator. For the database test account use a password with URL-safe characters. `RECOVERY_ESCROW_KEY` and `QORLLA_VAULT_KEY` must each decode from base64 to exactly 32 bytes; `ENCRYPT_KEY` must be 64 hex characters. Do not copy real deployment secrets into a certification file.

Start a new isolated stack (the script refuses existing project names, volumes, or Meet DB containers):

```powershell
powershell -File cert/stack-up.ps1 -EnvFile <cert.env> -ProjectName <unique-project>
node cert/run-security.mjs <cert.env>
```

`run-security.mjs` starts and stops its local Meet Node process. The stack-up script does not tear down old projects or delete volumes. After the run, remove only the project created for that run:

```powershell
powershell -File cert/stack-down.ps1 -EnvFile <cert.env> -ProjectName <unique-project> -MeetDbContainerName <unique-meet-db-container>
```

That command preserves database volumes by default. Add `-RemoveVolumes` only when the project and its data are confirmed disposable. The security evidence describes automated checks only; a green run is not an independent penetration test or production deployment approval.

## Functional certification

`run-cert.mjs` covers the broader browser/service flow. Its disposable-stack requirements and evidence output are documented by that runner; do not reuse production databases for certification.

Notes: C12 shares the C13 browser session (it records leaving Meet and landing back on MAIN). C20 simulates the lease state by editing the outbox row; C19 fast-forwards backoff timestamps.
