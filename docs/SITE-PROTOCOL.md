# Site protocol contract

The bridge intentionally uses the existing private modeling-center runner contract:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/runner/register` | POST | Consume pairing code and register a device |
| `/api/runner/poll` | GET | Heartbeat and atomically claim one matching queued task |
| `/api/runner/events` | POST | Report planning/modeling/validation/delivery progress |
| `/api/runner/artifacts` | POST multipart | Upload one validated artifact |
| `/api/runner/complete` | POST | Mark the claimed task completed or failed |

The runner sends `Authorization: Bearer <runner-token>` on all post-pair requests and `OAI-Sites-Authorization: Bearer <site-bypass-token>` for Sites dispatch. The local state module keeps both values out of source control.

The server remains the source of truth for task ownership. This client does not add a second queue, a shared bot login, or a cross-device credential cache.
