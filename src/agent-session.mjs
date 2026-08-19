import { normalizeAgent } from "./constants.mjs";
import { runClaudeTurn } from "./claude-session.mjs";
import { runCodexTurn } from "./codex-session.mjs";
import { agentTelemetry } from "./usage.mjs";

export async function runAgentTurn({ agent, taskDirectory, prompt, config, previousSession, onEvent }) {
  const selectedAgent = normalizeAgent(agent || config?.agent);
  let result;
  if (selectedAgent === "claude") {
    result = await runClaudeTurn({ taskDirectory, prompt, config, previousSession, onEvent });
  } else {
    result = await runCodexTurn({
      taskDirectory,
      prompt,
      config,
      previousThreadId: previousSession?.threadId,
      onEvent,
    });
  }
  return { ...result, ...agentTelemetry(selectedAgent, result.events, config?.model, result.usage) };
}

export function sessionReference(session) {
  if (!session) return null;
  if (session.agent === "claude" && session.sessionId) return session.sessionId;
  if (session.threadId) return session.threadId;
  return null;
}
