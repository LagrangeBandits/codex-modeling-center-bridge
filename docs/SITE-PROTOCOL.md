# Site protocol contract

The bridge intentionally uses the existing private modeling-center runner contract. The desktop app is a task connector, not a personal Codex-chat synchronizer:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/runner/register` | POST | Consume pairing code and register a device |
| `/api/runner/poll` | GET | Heartbeat and atomically claim one matching queued task |
| `/api/runner/events` | POST | Report planning/modeling/validation/delivery progress |
| `/api/runner/artifacts` | POST multipart | Upload one validated artifact |
| `/api/runner/complete` | POST | Mark the claimed task completed, planned, or failed |

The runner sends `Authorization: Bearer <runner-token>` on all post-pair requests and `OAI-Sites-Authorization: Bearer <site-bypass-token>` for Sites dispatch. The local state module keeps both values out of source control.

The server remains the source of truth for task ownership. This client does not add a second queue, a shared bot login, or a cross-device credential cache.

## Optional local agent

`/api/runner/register` may receive an `agent` field with the value `codex` or `claude`. If the server returns an `agent`, the bridge stores that selection locally and uses it for this runner. A task may also carry an optional `agent`; the runner accepts it only when it matches the agent selected at pairing time, so a device cannot silently run a task with a different local login.

The site does not receive the Agent's login state, API key, personal chat history, or raw local event stream. It receives only progress, validated artifacts, and the redacted task summary that the bridge places in `artifacts/conversation.md`.

## Optional Agent telemetry

The bridge may add `provider`, `model`, and `usage` to `/api/runner/events` and `/api/runner/complete`. These fields are optional, so older sites ignore them and older Runners can continue sending the original payload shape.

```json
{
  "provider": "openai",
  "model": "gpt-5.4",
  "usage": {
    "inputTokens": 120,
    "outputTokens": 18,
    "totalTokens": 138,
    "cachedInputTokens": 30,
    "cacheWriteInputTokens": 4,
    "cacheCreationInputTokens": null,
    "cacheReadInputTokens": null,
    "reasoningOutputTokens": 7
  }
}
```

`provider` is `openai` for Codex and `anthropic` for Claude Code. `model` is the model name only when the local response or an explicit local configuration provides it; otherwise it is `null`. `inputTokens`/`outputTokens` are the normalized input/prompt and output/completion counts. `totalTokens` uses the provider's reported total or the exact sum of reported input and output values. Provider-specific cache and reasoning counts remain separate. When the local terminal response has no reliable token fields, the bridge sends `null` values and writes the reason only to the local log.

The usage payload contains aggregate numeric values and `null` only. It never contains API keys, login state, raw transcripts, complete provider events, or arbitrary provider fields. Unknown `usage` fields must be ignored by the site.

## Optional execution mode

The polled task may include `executionMode`. Missing or `direct` means the normal CAD workflow. `plan` asks the local Agent to return a modeling plan only: the bridge runs the Agent in read-only mode, does not execute CAD tools, does not upload model artifacts, and completes with `status: "planned"`. The site can confirm the plan by re-queuing a direct task. Existing tasks without `executionMode` remain direct.
