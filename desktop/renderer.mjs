const api = window.modelingCenter;
const $ = (id) => document.getElementById(id);

function setMessage(message, isError = false) {
  const target = $("statusMessage");
  target.textContent = message || "";
  target.className = isError ? "message error" : "message";
}

function addLog(line) {
  const log = $("runnerLog");
  if (log.textContent === "等待操作…") log.textContent = "";
  log.textContent = `${log.textContent}${log.textContent ? "\n" : ""}${line}`.slice(-12_000);
  log.scrollTop = log.scrollHeight;
}

function statusValue(ok, value, optional = false) {
  if (ok) return `✓ ${value || "已就绪"}`;
  return optional ? "— 未发现（可选）" : "— 未就绪";
}

function renderStatus(payload) {
  const { config, report, runner } = payload;
  if (config.agent) $("agent").value = config.agent;
  if (config.site && !$('site').value) $("site").value = config.site;
  const items = [
    ["平台", report.platform],
    ["Node.js", statusValue(report.nodeSupported, report.node)],
    ["Python", statusValue(Boolean(report.modelingPython), report.modelingPython?.version)],
    ["CadQuery", statusValue(report.cadquery?.installed, report.cadquery?.version)],
    ["Codex", statusValue(report.codex?.installed, report.codex?.version, true)],
    ["Claude Code", statusValue(report.claude?.installed, report.claude?.version, true)],
    ["网站配对", config.paired ? `✓ ${config.name || "已配对"}` : "— 未配对"],
    ["工作区", config.workspace || "—"],
  ];
  $("environment").replaceChildren(...items.map(([label, value]) => {
    const item = document.createElement("div");
    item.className = "status-item";
    const name = document.createElement("span");
    name.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(name, content);
    return item;
  }));
  renderRunner(runner);
}

function renderRunner(runner) {
  const badge = $("runnerBadge");
  badge.className = `badge ${runner.running ? "running" : "idle"}`;
  badge.textContent = runner.running ? `Runner 运行中 · ${runner.agent === "claude" ? "Claude Code" : "Codex"}` : "Runner 未启动";
  $("startButton").disabled = runner.running;
  $("stopButton").disabled = !runner.running;
  if (runner.output?.length) $("runnerLog").textContent = runner.output.join("\n");
}

async function refresh() {
  try {
    renderStatus(await api.getStatus());
    setMessage("");
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

$("refreshButton").addEventListener("click", refresh);
$("pairButton").addEventListener("click", async () => {
  const button = $("pairButton");
  button.disabled = true;
  setMessage("正在验证配对码并保存本机安全凭据…");
  try {
    const result = await api.pair({
      site: $("site").value.trim(),
      code: $("code").value.trim(),
      siteAuth: $("siteAuth").value,
      name: $("deviceName").value.trim(),
      agent: $("agent").value,
    });
    $("siteAuth").value = "";
    setMessage(`配对成功：${result.response.name || "设备已连接"}`);
    renderStatus(result.status);
  } catch (error) {
    setMessage(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
});

$("startButton").addEventListener("click", async () => {
  try {
    const state = await api.startRunner({ agent: $("agent").value });
    renderRunner(state);
    addLog(`已启动 ${state.agent === "claude" ? "Claude Code" : "Codex"} Runner。`);
  } catch (error) {
    setMessage(error.message || String(error), true);
    addLog(`启动失败：${error.message || error}`);
  }
});

$("stopButton").addEventListener("click", async () => {
  const state = await api.stopRunner();
  renderRunner(state);
  addLog("已请求停止 Runner。已有任务会由网站按失败/超时策略处理。");
});

api.onRunnerEvent((event) => {
  if (event.type === "output") addLog(`[${event.stream}] ${event.line}`);
  if (event.type === "started") addLog(`Runner 已启动，使用 ${event.agentLabel}。`);
  if (event.type === "stopped") addLog(`Runner 已停止（退出码 ${event.code ?? "未知"}）。`);
  if (event.type === "error") setMessage(event.message, true);
  if (["started", "stopped"].includes(event.type)) api.runnerStatus().then(renderRunner);
});

refresh();
