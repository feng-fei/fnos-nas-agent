# Phase 132 — Real NAS staging acceptance

The audit that started this round listed "no real NAS staging acceptance" as an open
risk. This phase records the acceptance run that closed it.

## 1. Scope of the run

The acceptance was executed on a real fnOS appliance:

| Item | Value |
| --- | --- |
| Appliance | fnOS NAS, `172.28.10.2` |
| Appliance user | `feng` (uid 1000) |
| Node runtime used | `/var/apps/nodejs_v24/target/bin/node` → `v26.9.0` |
| Code under test | the `feature/security-hardening-and-release-consistency` work tree, `apps/fnos-nas-agent/app` |
| Staging root | `/home/feng/fnos-agent-stage` |
| Storage roots | `AGENT_FILE_ROOTS=/home/feng/fnos-agent-stage/files` (isolated from `/vol1`) |
| Port | `18899` (the installed service on `18787` was **not** touched) |

The acceptance instance ran from a scratch directory in the appliance home. The installed
FPK (`/vol1/@appcenter/fnos-nas-agent`, pid 214537) was never stopped, replaced or
reconfigured; it was verified healthy before and after the run.

Everything the run created — the staging directory, the test file, the cookie jars and the
uploaded tarball — was deleted afterwards. No existing business data was read, written or
removed.

## 2. First-run setup requires the installation code

```
fnos-nas-agent first-run setup code: d7b7959edd44e37376097a78
```

- `setup-code.txt` was created in the data directory with mode `0600`.
- A request from the LAN address reported `{"setupRequired":true,"setupCodeRequired":true}`.
- A request from `127.0.0.1` reported `{"setupRequired":true,"setupCodeRequired":false}`.
- `POST /api/setup` without a code → `403 {"error":"Setup code is invalid"}`.
- `POST /api/setup` with a wrong code → `403 {"error":"Setup code is invalid"}`.
- `POST /api/setup` with the correct code → `201 {"configured":true}`.
- After the success, `setup-code.txt` was gone and `password.json` / `sessions.json` /
  `audit.jsonl` existed with mode `0600`.
- A second `POST /api/setup` → `409 {"error":"Setup already completed"}`.

## 3. The kill switch is operable on the appliance

| Request | Result |
| --- | --- |
| `GET /api/execution-mode` | `200 {"mode":"normal","source":"default","modes":["normal","read-only","halted"]}` |
| `GET /api/execution-mode` without a session | `401` |
| `POST /api/execution-mode {"mode":"root"}` | `400 {"error":"Unknown execution mode; expected one of normal, read-only, halted"}` |
| `POST /api/execution-mode {"mode":"halted"}` | `200 {"mode":"halted","source":"state-file"}` |
| `GET /api/health` while halted | `{"executionMode":"halted","executionModeSource":"state-file"}` |
| `POST /api/tools/system.status/run` while halted | `503 {"error":"The agent is halted by the kill switch; no operation is accepted."}` |
| `POST /api/execution-mode {"mode":"normal"}` while halted | `200` — the switch can always be lifted |
| `POST /api/tools/system.status/run` after lifting | `200` |

`execution-mode.json` was written with mode `0600` and survived a restart: the service
came back with `executionMode: "halted"` and `executionModeSource: "state-file"`, and no
new setup code was generated because a password already existed.

## 4. Read-only mode blocks writes and keeps reads working

| Request while `read-only` | Result |
| --- | --- |
| `POST /api/tools/files.create-text/run` | `403 {"error":"The agent is in global read-only mode; this operation is not allowed."}` |
| `POST /api/tools/files.list/run` | `200` with the directory listing |

## 5. A destructive action needs a server-held, session-bound confirmation

1. `POST /api/files/operation {"action":"delete","path":…/hello.txt"}` → `202` with
   `approvalRequired: true` and an approval record that carries `sessionId`, `toolId:
   "files.delete"`, `risk: "destructive"` and the exact target. The file was still on disk.
2. `GET /api/actions/pending` listed exactly that one record.
3. A **second** session called `POST /api/actions/{id}/confirm` → `403 {"error":"The
   pending action belongs to another session"}`. The file was still on disk, so the
   attempt did not consume the grant.
4. The owning session called `POST /api/actions/{id}/confirm` → `200` with
   `{"confirmed":true, …, "result":{"action":"delete","deleted":true}}` and the file was
   gone.

Write and read paths were exercised in the same run: `mkdir` through
`POST /api/files/operation` returned `200`, and `files.create-text` through
`POST /api/tools/{id}/run` created a `0600` file.

## 6. The audit trail records the session

Every entry of `audit.jsonl` carries the session digest of the caller, for example:

```json
{"at":"2026-10-22T03:17:00.238Z","method":"POST","route":"actions.confirm","statusCode":200,"outcome":"success","sessionId":"a58afd99…"}
{"at":"2026-10-22T03:17:06.540Z","method":"POST","route":"tools.run","statusCode":403,"outcome":"rejected","sessionId":"a58afd99…"}
```

A rejected action is recorded with the same shape as a successful one, and a login event
has no `sessionId` because no session existed yet.

## 7. Remaining gap

The appliance still runs the previously installed build. The FPK produced by CI has to be
installed through the fnOS application center before the appliance serves the new build;
that step needs an application-center login, which was not available during this run.
