# Site protocol contract

The bridge intentionally uses the existing private modeling-center runner contract. The desktop app is a task connector, not a personal Codex-chat synchronizer:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/runner/register` | POST | Consume pairing code and register a device |
| `/api/runner/poll` | GET | Heartbeat and atomically claim one matching queued task |
| `/api/runner/events` | POST | Report planning/modeling/validation/delivery progress |
| `/api/runner/artifacts` | POST multipart | Upload one validated artifact |
| `/api/runner/complete` | POST | Mark the claimed task completed or failed |

The runner sends `Authorization: Bearer <runner-token>` on all post-pair requests and `OAI-Sites-Authorization: Bearer <site-bypass-token>` for Sites dispatch. The local state module keeps both values out of source control.

The server remains the source of truth for task ownership. This client does not add a second queue, a shared bot login, or a cross-device credential cache.

## Optional local agent

`/api/runner/register` may receive an `agent` field with the value `codex` or `claude`. If the server returns an `agent`, the bridge stores that selection locally and uses it for this runner. A task may also carry an optional `agent`; the runner accepts it only when it matches the agent selected at pairing time, so a device cannot silently run a task with a different local login.

The site does not receive the Agent's login state, API key, personal chat history, or raw local event stream. It receives only progress, validated artifacts, and the redacted task summary that the bridge places in `artifacts/conversation.md`.
