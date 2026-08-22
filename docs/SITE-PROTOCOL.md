# Site protocol contract

The bridge intentionally uses the existing private modeling-center runner contract. The desktop app is a task connector, not a personal Codex-chat synchronizer:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/runner/register` | POST | Consume pairing code and register a device |
| `/api/runner/poll` | GET | Atomically claim one matching queued task |
| `/api/runner/heartbeat` | POST | Optional device availability and resource heartbeat |
| `/api/runner/events` | POST | Report planning/modeling/validation/delivery progress |
| `/api/runner/messages` | GET/POST | Optional task-local user supplement and Runner assistant/system message bridge |
| `/api/runner/cancel` | POST | Optional explicit cancellation settlement |
| `/api/runner/usage` | POST | Replay a locally stored usage record for a task without changing its task status |
| `/api/runner/artifacts` | POST multipart | Upload one validated artifact |
| `/api/runner/complete` | POST | Mark the claimed task completed, planned, or failed |

The runner sends `Authorization: Bearer <runner-token>` on all post-pair requests and `OAI-Sites-Authorization: Bearer <site-bypass-token>` for Sites dispatch. The local state module keeps both values out of source control.

The server remains the source of truth for task ownership. This client does not add a second queue, a shared bot login, or a cross-device credential cache.

## Optional local agent

`/api/runner/register` accepts a safe Agent ID made of letters, numbers, dots, underscores, and hyphens. The bridge keeps the compatibility aliases `claude-code` and local `claude`, and can dispatch built-in profiles for Codex, Claude Code, Gemini CLI, Qwen Code, Trae Agent CLI, OpenCode, GitHub Copilot CLI, and Aider. A task may carry any matching Agent ID; the Runner never silently substitutes a different paired Agent or login.

At startup and in `doctor`, the bridge probes every built-in command with its version flag. Additional CLIs can be declared in the local `config.json` under `cliAgents`, for example:

```json
{
  "cliAgents": [
    {
      "id": "my-agent",
      "label": "My Agent",
      "command": "my-agent",
      "directArgs": ["run", "{prompt}", "--cwd", "{cwd}"],
      "outputFormat": "jsonl",
      "modelArgs": ["--model", "{model}"]
    }
  ]
}
```

Custom profiles use an argument array and `spawn` without a shell. Supported placeholders are `{prompt}`, `{cwd}`, `{taskDir}`, `{workspace}`, `{session}`, `{model}`, and `{provider}`. A profile can declare `planArgs` for a read-only planning mode; without it the bridge refuses to pretend that the CLI is read-only. CLI output is normalized from text, JSON, or JSON Lines. Usage and provider/model fields remain `null`/`unknown` when the CLI does not return reliable structured telemetry.

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

The poll response may include `task.maxArtifactBytes`, `task.priority`, and `task.modelPreference`. `maxArtifactBytes: 0` means no application-level per-file limit; the site or transport may still impose its own upload/request limit. Priority is server-owned: the Runner reports it for observability and does not create a second local queue. A model preference is passed only to the selected local Agent adapter; it never contains a secret. If a historical task has already finished but its local `events.jsonl` was retained, `codex-modeling-bridge reconcile <task-id>` replays only the normalized provider/model/usage payload to `/api/runner/usage`; the endpoint is ownership-checked and settlement remains idempotent.

## Optional Runner heartbeat

When paired, the Runner may POST the following aggregate device state to `/api/runner/heartbeat` at startup, after task-state changes, and at a bounded interval while polling:

```json
{
  "runnerId": "runner-id",
  "platform": "macos",
  "agent": "trae",
  "provider": "unknown",
  "model": "gpt-5.6-luna",
  "softwareVersion": "0.1.2",
  "activeTasks": 1,
  "capacity": 1,
  "cpuPercent": 34.2,
  "memoryUsedBytes": 123456789,
  "memoryTotalBytes": 17179869184,
  "load1m": 1.02,
  "capabilities": ["task:direct", "task:plan", "task:cancel", "task:priority", "bridge:messages", "agent:trae", "cli:auto-discovery"]
}
```

The request uses the same `Authorization: Bearer <runner-token>` and `OAI-Sites-Authorization: Bearer <site-bypass-token>` headers as other post-pair requests. Metrics that the platform cannot provide are `null`; the Runner never fabricates zeros. A `404` or `405` response disables this optional call for the current process and does not interrupt polling, task execution, artifact upload, or completion, so older sites remain compatible. The heartbeat contains no secrets, authentication state, or transcript data.

## Optional task control and web messages

When the site supports interactive task control, the Runner polls the following endpoint while a task is active and at safe checkpoints:

```http
GET /api/runner/messages?taskId=<task-id>&after=<opaque-cursor>
Authorization: Bearer <runner-token>
OAI-Sites-Authorization: Bearer <site-bypass-token>
```

The response may contain:

```json
{
  "cursor": "opaque-cursor",
  "cancelRequestedAt": null,
  "messages": [
    {"id": "message-id", "role": "user", "content": "补充孔距 30 mm"}
  ]
}
```

The bridge accepts `cancelRequestedAt` or the compatible boolean fields `cancelRequested`, `cancelled`, and `canceled`. It stops at the next control checkpoint, aborts the Codex SDK turn or terminates the Claude Code child process, and reports cancellation through `POST /api/runner/cancel` when available. The explicit cancellation body is `{taskId, reason, provider, model, usage}` and contains no transcript. If `/api/runner/cancel` is unavailable, the Runner tries `status: "cancelled"` on `/api/runner/complete`; an old site that rejects that status receives a clearly logged `failed` compatibility settlement so the claimed task is not left stuck.

For an assistant/system message, the Runner may send:

```http
POST /api/runner/messages
Content-Type: application/json

{"taskId":"task-id","role":"assistant","message":"方案已生成，等待确认。","after":"opaque-cursor"}
```

Messages are length-limited and normalized before entering a local prompt or crossing the site boundary. A `404` or `405` disables this optional bridge and does not interrupt the normal task flow. Existing plan continuation through the site's normal requeue path remains supported: the next poll can carry `messages`, `webMessages`, or `continuationMessages`, and the Runner resumes the task-local Agent session rather than personal chat history.

## Optional execution mode

The polled task may include `executionMode`. Missing or `direct` means the normal CAD workflow. `plan` asks the local Agent to return a modeling plan only: the bridge runs the Agent in read-only mode, does not execute CAD tools, does not upload model artifacts, and completes with `status: "planned"`. The site can confirm the plan by re-queuing a direct task. Existing tasks without `executionMode` remain direct.

## Model preference passthrough

The site may return `modelPreference` as the normalized string `auto` or a model name such as `deepseek-chat`/`qwen-plus`; it may also return the compatible object `{ "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" }`. `auto` leaves the local configuration unchanged. The Runner also accepts the equivalent task-level fields and `baseUrl`/`apiBaseUrl` when explicitly configured. Codex receives the model, reasoning effort, optional base URL, and a safe `model_provider` config override; Claude Code receives the model and safe endpoint/provider environment hints. The bridge still reports the identity observed in the real local response first. It never turns `codex` into `openai` or `claude` into `anthropic` without evidence.

## Usage sequences and real-time reporting

`/api/runner/usage` and the existing event/complete payloads may carry these optional fields in addition to `provider`, `model`, and `usage`:

- `attemptId`: task-attempt identifier, never a secret or transcript;
- `sequence`: monotonic task-local sequence starting at 1; the site should deduplicate by `taskId + attemptId + sequence`;
- `usageMode`: `cumulative` or `delta`;
- `usageSource`: for example `codex:event`, `claude:event`, or `bridge:reconcile`;
- `usageComplete`: whether the local Agent supplied complete terminal usage;
- `observedAt`: local observation timestamp.

Bridge sends only allowlisted aggregate token numbers. When the real CLI/OAuth response cannot be read reliably, usage fields remain `null` and the reason stays in the local log. API keys, authentication state, raw events, and transcripts never cross the site boundary. Repeated sequences must be idempotent and must not be counted twice.

## Quota pause and checkpoints

The poll/control response may carry `action: "pause"`, `quotaState` (`ok`, `insufficient`, `rate_limited`, `auth_required`, or `unknown`), `pauseRequested`, `pauseReason`, `retryAfter`, `attemptId`, and an optional `checkpoint`. Bridge pauses only before an Agent turn, at a complete turn/tool boundary, or before artifact upload.

Bridge reports checkpoints through `POST /api/runner/checkpoint`. If the endpoint returns 404/405 it tries `POST /api/runner/pause`; if both are unavailable it uses the legacy complete fallback and never claims a resumable checkpoint. A checkpoint contains `checkpointId`, `checkpointVersion`, `stage`, `resumeSupported`, `resumeFrom`, and `reasonCode`. Codex/Claude are marked resumable only when a real local session reference exists; a generic CLI must explicitly declare resume support. The optional `POST /api/runner/resume` endpoint can resume an existing attempt, or the site can confirm and requeue the task.

## Capability heartbeat

Heartbeat `capabilities` declares `task:pause`, `task:checkpoint`, `task:resume` when supported, and `telemetry:usage` or `telemetry:usage:unknown`, together with each Agent's direct/plan/provider-model capabilities. Unknown capability is never reported as full support.
