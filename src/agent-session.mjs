import { normalizeAgent } from "./constants.mjs";
import { runClaudeTurn } from "./claude-session.mjs";
import { runCodexTurn } from "./codex-session.mjs";
import { identityFromEvents, loadLocalAgentIdentity } from "./agent-identity.mjs";
import { usagePayload } from "./usage.mjs";

export async function runAgentTurn({ agent, taskDirectory, prompt, config, previousSession, onEvent, initialIdentity, signal }) {
  const selectedAgent = normalizeAgent(agent || config?.agent);
  const localIdentity = initialIdentity || await loadLocalAgentIdentity(selectedAgent, config);
  let result;
  if (selectedAgent === "claude") {
    result = await runClaudeTurn({ taskDirectory, prompt, config, previousSession, onEvent, signal });
  } else {
    result = await runCodexTurn({
      taskDirectory,
      prompt,
      config,
      previousThreadId: previousSession?.threadId,
      onEvent,
      signal,
    });
  }
  const identity = identityFromEvents(selectedAgent, result.events, localIdentity);
  return {
    ...result,
    provider: identity.provider,
    model: identity.model,
    usage: usagePayload(result.usage),
  };
}

export function sessionReference(session) {
  if (!session) return null;
  if (session.agent === "claude" && session.sessionId) return session.sessionId;
  if (session.threadId) return session.threadId;
  return null;
}
