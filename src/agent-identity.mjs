import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeAgent } from "./constants.mjs";
import { modelFromEvent } from "./usage.mjs";

export const UNKNOWN_PROVIDER = "unknown";

function safeModel(value) {
  if (typeof value !== "string") return null;
  const model = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
  if (!model || /(?:bearer\s+|sk-[a-z0-9_-]+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=])/i.test(model)) return null;
  return model;
}

export function normalizeProvider(value) {
  if (typeof value !== "string") return null;
  const provider = value.trim();
  if (!provider) return null;
  if (/^(?:unknown|null|undefined|n\/a|none)$/i.test(provider)) return UNKNOWN_PROVIDER;
  if (/(?:bearer\s+|sk-[a-z0-9_-]+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=])/i.test(provider)) return null;
  const normalized = provider.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80).trim().toLowerCase();
  return normalized || null;
}

function firstString(...values) {
  return values.map((value) => (typeof value === "string" ? value.trim() : "")).find(Boolean) || null;
}

function firstProvider(...values) {
  for (const value of values) {
    const provider = normalizeProvider(value);
    if (provider) return provider;
  }
  return null;
}

function firstKnownProvider(...values) {
  const provider = firstProvider(...values);
  return provider && provider !== UNKNOWN_PROVIDER ? provider : null;
}

function firstModel(...values) {
  for (const value of values) {
    const model = safeModel(value);
    if (model) return model;
  }
  return null;
}

export function providerFromBaseUrl(value, agent = "codex") {
  if (typeof value !== "string" || !value.trim()) return null;
  let hostname;
  try {
    hostname = new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!hostname) return null;
  if (hostname.includes("deepseek")) return "deepseek";
  if (hostname.includes("dashscope") || hostname.includes("aliyuncs") || hostname.includes("qianwen")) return "dashscope";
  if (hostname === "api.openai.com" || hostname.endsWith(".openai.com")) return "openai";
  // A configured custom endpoint proves the wire compatibility, but not the
  // vendor. Keep that distinction explicit instead of claiming OpenAI.
  return agent === "claude" ? "anthropic-compatible" : "openai-compatible";
}

export function providerFromModel(model) {
  const value = safeModel(model);
  if (!value) return null;
  const lower = value.toLowerCase();
  if (/^(?:deepseek)(?:[-_:.]|$)/.test(lower)) return "deepseek";
  if (/^(?:qwen|qwq|tongyi)(?:[-_:.]|$)/.test(lower)) return "qwen";
  if (/(?:dashscope|aliyun)/.test(lower)) return "dashscope";
  if (/^(?:claude)(?:[-_:.]|$)/.test(lower)) return "anthropic";
  // GPT/o-series names are intentionally not enough evidence: many
  // OpenAI-compatible providers expose those names through a custom endpoint.
  return null;
}

function providerFields(event) {
  return [
    event?.provider,
    event?.provider_name,
    event?.providerName,
    event?.model_provider,
    event?.modelProvider,
    event?.metadata?.provider,
    event?.metadata?.provider_name,
    event?.message?.provider,
    event?.message?.metadata?.provider,
    event?.item?.provider,
    event?.item?.model_provider,
    event?.response?.provider,
    event?.result && typeof event.result === "object" ? event.result.provider : null,
    event?.usage?.provider,
  ];
}

export function providerFromEvent(event) {
  return firstProvider(...providerFields(event));
}

export function identityFromEvent(event, fallback = {}) {
  const model = modelFromEvent(event) || safeModel(fallback.model);
  const provider = providerFromEvent(event)
    || firstKnownProvider(fallback.provider)
    || providerFromBaseUrl(fallback.baseUrl, fallback.agent)
    || providerFromModel(model)
    || UNKNOWN_PROVIDER;
  return { provider, model: model || null };
}

export function identityFromEvents(agent, events, fallback = {}) {
  const selectedAgent = normalizeAgent(agent);
  let model = null;
  let provider = null;
  for (const event of [...(Array.isArray(events) ? events : [])].reverse()) {
    if (!model) model = safeModel(modelFromEvent(event));
    if (!provider) provider = providerFromEvent(event);
    if (model && provider) break;
  }
  model = model || firstModel(fallback.model);
  provider = provider
    || firstKnownProvider(fallback.provider)
    || providerFromBaseUrl(fallback.baseUrl, selectedAgent)
    || providerFromModel(model)
    || UNKNOWN_PROVIDER;
  return { provider, model: model || null };
}

function parseTomlString(value) {
  const match = String(value).match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)')\s*(?:#.*)?$/);
  if (!match) return null;
  return (match[2] ?? match[3] ?? "").replace(/\\([\\"])/g, "$1");
}

function parseCodexToml(text) {
  const values = {};
  const providerBaseUrls = {};
  let providerSection = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[model_providers\.([^\]]+)\]\s*$/);
    if (section) {
      providerSection = section[1].trim();
      continue;
    }
    if (line.startsWith("[")) {
      providerSection = null;
      continue;
    }
    const value = parseTomlString(line);
    if (!value) continue;
    const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1];
    if (!key) continue;
    if (providerSection && key === "base_url") providerBaseUrls[providerSection] = value;
    if (!providerSection && (key === "model" || key === "model_provider")) values[key] = value;
  }
  const provider = values.model_provider || null;
  return {
    provider,
    model: values.model || null,
    baseUrl: provider ? providerBaseUrls[provider] || null : null,
  };
}

async function readFirstFile(paths, parser) {
  for (const filename of paths.filter(Boolean)) {
    try {
      return parser(await fs.readFile(filename, "utf8"));
    } catch {
      // Optional local configuration is not present on every device.
    }
  }
  return {};
}

function configDirectory(envName, fallbackParts) {
  return process.env[envName] || path.join(os.homedir(), ...fallbackParts);
}

async function readCodexIdentity() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return readFirstFile([path.join(codexHome, "config.toml")], parseCodexToml);
}

function parseClaudeJson(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const env = value.env && typeof value.env === "object" ? value.env : {};
    return {
      provider: firstString(value.provider, value.modelProvider, value.model_provider, env.CLAUDE_PROVIDER),
      model: firstString(value.model, value.modelName, value.model_name, env.CLAUDE_MODEL, env.ANTHROPIC_MODEL),
      baseUrl: firstString(value.baseUrl, value.apiBaseUrl, value.api_base_url, env.ANTHROPIC_BASE_URL),
    };
  } catch {
    return {};
  }
}

async function readClaudeIdentity() {
  const configDirectoryPath = configDirectory("CLAUDE_CONFIG_DIR", [".claude"]);
  return readFirstFile([
    path.join(configDirectoryPath, "settings.json"),
    path.join(os.homedir(), ".claude.json"),
  ], parseClaudeJson);
}

function environmentIdentity(agent) {
  const selectedAgent = normalizeAgent(agent);
  const genericPrefix = selectedAgent.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const names = selectedAgent === "claude"
    ? {
        provider: ["CLAUDE_PROVIDER", "CLAUDE_CODE_PROVIDER", "MODEL_PROVIDER"],
        model: ["CLAUDE_MODEL", "ANTHROPIC_MODEL"],
        baseUrl: ["ANTHROPIC_BASE_URL", "CLAUDE_BASE_URL"],
      }
    : selectedAgent === "codex"
      ? {
        provider: ["CODEX_PROVIDER", "CODEX_MODEL_PROVIDER", "MODEL_PROVIDER"],
        model: ["CODEX_MODEL", "OPENAI_MODEL"],
        baseUrl: ["CODEX_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_BASE_URL"],
      }
      : {
        provider: [`${genericPrefix}_PROVIDER`, `${genericPrefix}_MODEL_PROVIDER`, "MODEL_PROVIDER"],
        model: [`${genericPrefix}_MODEL`, "MODEL_NAME"],
        baseUrl: [`${genericPrefix}_BASE_URL`, "MODEL_BASE_URL"],
      };
  const firstEnv = (keys) => keys.map((key) => process.env[key]).find((value) => typeof value === "string" && value.trim()) || null;
  return {
    provider: firstEnv(names.provider),
    model: firstEnv(names.model),
    baseUrl: firstEnv(names.baseUrl),
  };
}

export async function loadLocalAgentIdentity(agent, config = {}) {
  const selectedAgent = normalizeAgent(agent);
  const local = selectedAgent === "claude"
    ? await readClaudeIdentity()
    : selectedAgent === "codex"
      ? await readCodexIdentity()
      : {};
  const environment = environmentIdentity(selectedAgent);
  const configured = {
    agent: selectedAgent,
    provider: firstString(config.provider, config.modelProvider, config.model_provider, environment.provider, local.provider),
    model: firstModel(config.model, config[`${selectedAgent}Model`], environment.model, local.model),
    baseUrl: firstString(config.baseUrl, config.apiBaseUrl, config.modelBaseUrl, environment.baseUrl, local.baseUrl),
  };
  return identityFromEvents(selectedAgent, [], configured);
}
