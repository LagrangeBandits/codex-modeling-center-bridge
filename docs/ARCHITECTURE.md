# Modeling Center Bridge architecture

```text
Private site (allowlisted task queue + delivery storage)
        │ HTTPS, one-time pairing + runner token
        ▼
Mac / Windows desktop app (Electron UI)
        │ local IPC, no secrets in renderer
        ▼
Shared Node 24 Runner
        ├── Codex adapter ── local Codex CLI/SDK login
        └── Claude adapter ── local Claude Code CLI login
                │
                ▼
        Python 3.11 + CadQuery/OpenCascade
```

The desktop program is the cross-platform product surface. The CLI remains available for diagnostics, installation, automation, and headless operation. Both surfaces call the same Runner and Agent adapters.

## Product boundary

The program connects a private modeling website to a user's own Mac or Windows device. It does not sync the user's personal Codex or Claude chat history, and it does not require the friend-facing website to launch a Codex conversation. One website task creates one task-local Agent session record under the local workspace; only the selected task's deliverables and redacted summary are eligible for upload.

## Task lifecycle

1. The owner creates a short-lived pairing code in the private site.
2. The desktop app sends the code and selected Agent to `/api/runner/register`.
3. The app stores the site bridge authorization and Runner token in macOS Keychain or Windows DPAPI.
4. The Runner polls the site. The server claims a queued task with a conditional update, so two devices cannot claim the same task.
5. The Runner creates an isolated task directory, applies the server priority/model preference, and dispatches the task to the configured Agent adapter.
6. While the Agent is running, an optional control channel receives website supplements and checks `cancel_requested_at` at bounded safe points. A cancellation aborts the active local turn and stops before artifact upload.
7. In plan mode the Agent is read-only and only a modeling proposal is returned; the site can send a follow-up message or confirm the plan and requeue direct execution.
8. In direct mode the Agent writes the CAD generator, runs local modeling/validation commands, and places deliverables in `artifacts/`.
9. The Runner uploads only allowed CAD/support files and marks the task complete after a real CAD file exists.

## Agent boundary

All Agent adapters receive the same task-local `AGENTS.md` modeling rules and use the same Python/CadQuery environment. Codex and Claude Code retain their native SDK/CLI session handling. Other built-in or custom CLI profiles run through the no-shell generic adapter, which accepts only explicit argument arrays and normalizes text/JSON/JSONL output. Older Codex records without an `agent` field remain readable as Codex records.

Claude runs as a subprocess with `stream-json`, a task-local settings file, a no-network allowlist, and a sandbox requirement. Native Windows Claude sandbox support is limited by Claude Code itself; unattended Claude tasks on Windows should run through WSL2. Codex remains available as the native Windows option.

## Account and quota boundary

The bridge does not accept or transmit a shared OpenAI or Anthropic API key. Each adapter uses the local installation and authentication already present on that device. The Claude adapter removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from its child process so an accidental API environment variable cannot silently switch the selected local CLI to an API billing path. OAuth credentials, if used by the official CLI, stay local and are never logged or uploaded.

## Desktop security boundary

The Electron renderer has no Node integration. Context isolation and a narrow preload IPC surface keep filesystem, process, pairing, and secret operations in the main process. Pairing secrets are sent only for the immediate local pairing call, then cleared from the form; stored credentials are read by the existing state module, not passed on command lines.

## Failure behavior

- Pairing codes expire and can be used once.
- Polling is safe to repeat; the server-side conditional claim prevents duplicate work.
- A task with an Agent different from the runner's configured Agent is rejected and reported failed rather than silently using another login or CLI.
- A failed task is reported as failed and leaves its local task directory for inspection.
- A failed dependency update does not delete an existing virtual environment.
- A runner can be restarted; queued tasks remain queued on the site.
- Server priority remains authoritative; the Runner never reorders or duplicates the site queue.
- A cancellation is checked before Agent startup, during streamed events, before uploads, and before settlement. If the optional control endpoint is missing, normal legacy execution continues.
- A website deletion of a terminal task becomes a separate persistent cleanup request. The Runner deletes only the matching direct child of its task root after path and symlink checks, then sends an idempotent path-free receipt; offline devices receive it on a later cleanup poll.
- Web supplements are task-local context only; they never open or synchronize a user's personal Codex/Claude conversation.
- Raw credentials are excluded from task prompts, transcripts, artifacts, and Git.

## Extensible Agents and checkpoints

The CLI registry separates discovery, argument construction, event parsing, identity/usage parsing, and capability reporting. Built-in profiles cover Codex, Claude, Gemini, Qwen, Trae, OpenCode, Copilot, and Aider. A discovered command is not treated as proof that direct, plan, streaming, usage, provider/model, cancellation, or resume are all supported; unknown capabilities remain `unknown`.

Usage is sent with a task-local `attemptId` and monotonic `sequence`, allowing cumulative snapshots and deltas to be deduplicated. Quota pauses happen only at safe boundaries. A local checkpoint contains only a session reference, stage, reason, aggregate usage, and safe artifact metadata; the site coordinates pause and resume.
