# Bridge architecture

```text
Private site (task queue + R2 delivery)
        │ HTTPS, one-time pairing + runner token
        ├── Mac Bridge ── local Codex SDK ── CadQuery/OpenCascade
        └── Windows Bridge ── local Codex SDK ── CadQuery/OpenCascade
```

The bootstrap path is user-scoped. Node 24 and uv are kept under the bridge's application data directory when they are missing; uv then manages a Python 3.11 runtime, and CadQuery is installed only inside the bridge's virtual environment. System Python, Codex login state, and OS credential stores are not overwritten.

## Task lifecycle

1. The owner creates a short-lived pairing code in the private site.
2. A device runs `pair`; the site atomically consumes the code and returns a runner token.
3. The bridge stores the site bypass token and runner token in OS-protected local storage.
4. Each bridge polls the site. The site claims a queued task with a conditional update, so two devices cannot claim the same task.
5. The bridge creates an isolated task directory and a fresh or resumable local Codex thread.
6. Codex writes the CAD generator, runs the local modeling/validation commands, and places deliverables in `artifacts/`.
7. The bridge uploads only allowed CAD/support files and marks the task complete after a real CAD file exists.

## Local conversation boundary

The bridge persists one `threadId` per website task. `sessions` lists only those task-bound IDs; it never scans or exports the rest of the user's Codex history. `resume` continues one selected task thread. The site receives a redacted `conversation.md` summary, while raw `events.jsonl` stays on the device.

## Account and quota boundary

The bridge does not accept or transmit a shared OpenAI API key. The Codex SDK inherits the local Codex CLI environment. Each device therefore uses the account already authenticated in its own Codex installation. If `OPENAI_API_KEY` is present, the bridge warns before starting because that may change the billing path.

## Failure behavior

- Pairing codes expire and can be used once.
- Polling is safe to repeat; the server-side conditional claim prevents duplicate work.
- A failed task is reported as failed and leaves its local task directory for inspection.
- A failed dependency update does not delete an existing virtual environment.
- A runner can be restarted; queued tasks remain queued on the site.
- Raw credentials are excluded from task prompts, transcripts, artifacts, and Git.
