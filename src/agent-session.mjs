import { normalizeAgent } from "./constants.mjs";
import { runClaudeTurn } from "./claude-session.mjs";
import { runCodexTurn } from "./codex-session.mjs";

export async function runAgentTurn({ agent, taskDirectory, prompt, config, previousSession, onEvent }) {
  const selectedAgent = normalizeAgent(agent || config?.agent);
  if (selectedAgent === "claude") {
    return runClaudeTurn({ taskDirectory, prompt, config, previousSession, onEvent });
  }
  return runCodexTurn({
    taskDirectory,
    prompt,
    config,
    previousThreadId: previousSession?.threadId,
    onEvent,
  });
}

export function sessionReference(session) {
  if (!session) return null;
  if (session.agent === "claude" && session.sessionId) return session.sessionId;
  if (session.threadId) return session.threadId;
  return null;
}
