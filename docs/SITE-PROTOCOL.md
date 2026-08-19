# Site protocol contract

The bridge intentionally uses the existing private modeling-center runner contract. The desktop app is a task connector, not a personal Codex-chat synchronizer:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/runner/register` | POST | Consume pairing code and register a device |
| `/api/runner/poll` | GET | Atomically claim one matching queued task |
| `/api/runner/heartbeat` | POST | Optional device availability and resource heartbeat |
| `/api/runner/events` | POST | Report planning/modeling/validation/delivery progress |
| `/api/runner/usage` | POST | Replay a locally stored usage record for a task without changing its task status |
| `/api/runner/artifacts` | POST multipart | Upload one validated artifact |
| `/api/runner/complete` | POST | Mark the claimed task completed, planned, or failed |

The runner sends `Authorization: Bearer <runner-token>` on all post-pair requests and `OAI-Sites-Authorization: Bearer <site-bypass-token>` for Sites dispatch. The local state module keeps both values out of source control.

The server remains the source of truth for task ownership. This client does not add a second queue, a shared bot login, or a cross-device credential cache.

## Optional local agent

`/api/runner/register` uses the wire values `codex` or `claude-code`; the bridge also accepts the local alias `claude`. If the server returns an `agent`, the bridge stores that selection locally and uses it for this runner. A task may also carry an optional `agent`; the runner accepts both `claude-code` and the local `claude` alias only when they match the agent selected at pairing time, so a device cannot silently run a task with a different local login.

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

`provider` and `model` are resolved from the local Agent response first, then explicit local configuration and known local provider endpoints. The bridge does not infer a provider solely from the selected Agent: `provider` may be `openai`, `openai-compatible`, `deepseek`, `qwen`, `dashscope`, `anthropic`, `anthropic-compatible`, another configured provider name, or `unknown` when the evidence is insufficient. A real model string is preserved when it can be identified safely, even when the provider remains `unknown`. `inputTokens`/`outputTokens` are the normalized input/prompt and output/completion counts. `totalTokens` uses the provider's reported total or the exact sum of reported input and output values. Provider-specific cache and reasoning counts remain separate. When the local terminal response has no reliable token fields, the bridge sends `null` values and writes the reason only to the local log.

The usage payload contains aggregate numeric values and `null` only. It never contains API keys, login state, raw transcripts, complete provider events, or arbitrary provider fields. Unknown `usage` fields must be ignored by the site.

The poll response may include `task.maxArtifactBytes`. The bridge checks each local artifact against that limit before opening an upload request. If a historical task has already finished but its local `events.jsonl` was retained, `codex-modeling-bridge reconcile <task-id>` replays only the normalized provider/model/usage payload to `/api/runner/usage`; the endpoint is ownership-checked and settlement remains idempotent.

## Optional Runner heartbeat

When paired, the Runner may POST the following aggregate device state to `/api/runner/heartbeat` at startup, after task-state changes, and at a bounded interval while polling:

```json
{
  "runnerId": "runner-id",
  "platform": "macos",
  "agent": "codex",
  "provider": "unknown",
  "model": "gpt-5.6-luna",
  "softwareVersion": "0.1.2",
  "activeTasks": 1,
  "capacity": 1,
  "cpuPercent": 34.2,
  "memoryUsedBytes": 123456789,
  "memoryTotalBytes": 17179869184,
  "load1m": 1.02,
  "capabilities": ["task:direct", "task:plan", "agent:codex"]
}
```

The request uses the same `Authorization: Bearer <runner-token>` and `OAI-Sites-Authorization: Bearer <site-bypass-token>` headers as other post-pair requests. Metrics that the platform cannot provide are `null`; the Runner never fabricates zeros. A `404` or `405` response disables this optional call for the current process and does not interrupt polling, task execution, artifact upload, or completion, so older sites remain compatible. The heartbeat contains no secrets, authentication state, or transcript data.

## Optional execution mode

The polled task may include `executionMode`. Missing or `direct` means the normal CAD workflow. `plan` asks the local Agent to return a modeling plan only: the bridge runs the Agent in read-only mode, does not execute CAD tools, does not upload model artifacts, and completes with `status: "planned"`. The site can confirm the plan by re-queuing a direct task. Existing tasks without `executionMode` remain direct.
