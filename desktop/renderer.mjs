const api = window.modelingCenter;
const $ = (id) => document.getElementById(id);

let latestStatus = null;
let environmentBusy = false;
let startingRunner = false;

function setMessage(message, isError = false) {
  const target = $("statusMessage");
  target.textContent = message || "";
  target.className = isError ? "toast error" : "toast";
}

function setPairingMessage(message, isError = false) {
  const target = $("pairingMessage");
  target.textContent = message || "";
  target.className = isError ? "message error" : "message";
}

function addLog(line) {
  const log = $("runnerLog");
  if (log.textContent === "等待操作…") log.textContent = "";
  log.textContent = `${log.textContent}${log.textContent ? "\n" : ""}${line}`.slice(-12_000);
  log.scrollTop = log.scrollHeight;
}

function statusValue(ok, value, missing = "未发现") {
  return ok ? `✓ ${value || "已就绪"}` : `— ${missing}`;
}

function platformLabel(value) {
  return { darwin: "macOS", macos: "macOS", win32: "Windows", windows: "Windows", linux: "Linux" }[value] || value || "本机";
}

function agentLabel(value) {
  return value === "claude" ? "Claude Code" : "Codex";
}

function renderEnvironment(report) {
  const nodeValue = report.nodeSupported
    ? statusValue(true, report.node)
    : statusValue(false, null, "未发现 Node.js 24+");
  const items = [
    ["平台", platformLabel(report.platform)],
    ["Node.js", nodeValue],
    ["Python", statusValue(Boolean(report.modelingPython), report.modelingPython?.version, "未发现")],
    ["CadQuery", statusValue(report.cadquery?.installed, report.cadquery?.version, "未安装")],
    ["Codex", statusValue(report.codex?.installed, report.codex?.version, "未发现")],
    ["Claude Code", statusValue(report.claude?.installed, report.claude?.version, "未发现")],
    ["云端连接", latestStatus.config.paired ? `✓ ${latestStatus.config.name || "已连接"}` : "— 未连接"],
    ["工作区", latestStatus.config.workspace || "—"],
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
}

function renderAgentAvailability(report) {
  const selected = $("agent").value;
  const result = report[selected];
  const target = $("agentAvailability");
  target.className = `agent-availability ${result?.installed ? "ready" : "missing"}`;
  target.textContent = result?.installed
    ? `✓ 已发现 ${agentLabel(selected)}：${result.version || "可用"}`
    : `— 未发现 ${agentLabel(selected)}，请先在本机安装并完成登录。`;
}

function renderCloud(config) {
  const paired = Boolean(config.paired);
  const connectionPill = $("connectionPill");
  connectionPill.className = `status-pill ${paired ? "running" : "neutral"}`;
  connectionPill.textContent = paired ? `已连接 · ${config.name || "本机设备"}` : "尚未连接";
  $("cloudState").textContent = paired ? "已连接" : "尚未连接";
  $("cloudDescription").textContent = paired
    ? "设备已进入云端任务队列，可以领取网站分配的建模任务。"
    : "连接后，这台设备才能领取网站分配的建模任务。";
  $("cloudSiteLabel").textContent = config.site || "尚未设置云端地址";
  for (const id of ["topOpenSiteButton", "heroOpenSiteButton", "openSiteButton"]) $(id).disabled = !config.site;
}

function renderRunner(runner) {
  const badge = $("runnerBadge");
  badge.className = `status-pill ${runner.running ? "running" : "neutral"}`;
  badge.textContent = runner.running
    ? `运行中 · ${agentLabel(runner.agent)}`
    : "未启动";
  $("startButton").disabled = runner.running || startingRunner || environmentBusy;
  $("stopButton").disabled = !runner.running;
  if (runner.output?.length) $("runnerLog").textContent = runner.output.join("\n");
}

function renderStatus(payload) {
  latestStatus = payload;
  const { config, report, runner } = payload;
  if (config.agent) $("agent").value = config.agent;
  if (config.site) $("site").value = config.site;
  renderEnvironment(report);
  renderAgentAvailability(report);
  renderCloud(config);
  renderRunner(runner);
}

async function refresh() {
  try {
    renderStatus(await api.getStatus());
    setMessage("");
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

function openPairing() {
  if (latestStatus?.config.site) $("site").value = latestStatus.config.site;
  setPairingMessage("");
  const dialog = $("pairingDialog");
  if (!dialog.open) dialog.showModal();
}

function closePairing() {
  const dialog = $("pairingDialog");
  if (dialog.open) dialog.close();
}

async function openSite() {
  try {
    await api.openSite();
    setMessage("已打开云端建模系统。");
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

async function prepareEnvironment() {
  if (environmentBusy) return;
  environmentBusy = true;
  $("repairEnvironmentButton").disabled = true;
  $("environmentProgress").textContent = "正在准备环境，请不要关闭软件…";
  setMessage("正在安装或修复本机建模环境…");
  renderRunner(latestStatus?.runner || { running: false });
  try {
    const result = await api.prepareEnvironment();
    if (result?.status) renderStatus(result.status);
    $("environmentProgress").textContent = "工作环境已准备完成，可以重新刷新状态或启动 Runner。";
    setMessage("本机建模环境已准备完成。");
  } catch (error) {
    $("environmentProgress").textContent = `准备失败：${error.message || error}`;
    setMessage(error.message || String(error), true);
  } finally {
    environmentBusy = false;
    $("repairEnvironmentButton").disabled = false;
    if (latestStatus) renderRunner(latestStatus.runner);
  }
}

async function submitPairing(event) {
  event.preventDefault();
  const button = $("pairButton");
  button.disabled = true;
  setPairingMessage("正在验证配对码并保存本机安全凭据…");
  try {
    const result = await api.pair({
      site: $("site").value.trim(),
      code: $("code").value.trim(),
      siteAuth: $("siteAuth").value,
      name: $("deviceName").value.trim(),
      agent: $("agent").value,
    });
    $("code").value = "";
    $("siteAuth").value = "";
    renderStatus(result.status);
    closePairing();
    setMessage(`连接成功：${result.response.name || "设备已连接"}`);
  } catch (error) {
    setPairingMessage(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

async function startRunner() {
  if (startingRunner) return;
  startingRunner = true;
  renderRunner(latestStatus?.runner || { running: false });
  setMessage("正在启动本地 Runner…");
  try {
    const state = await api.startRunner({ agent: $("agent").value });
    if (latestStatus) latestStatus.runner = state;
    renderRunner(state);
    addLog(`已启动 ${agentLabel(state.agent)} Runner。`);
    setMessage("本地 Runner 已启动，正在等待云端任务。");
  } catch (error) {
    setMessage(error.message || String(error), true);
    addLog(`启动失败：${error.message || error}`);
  } finally {
    startingRunner = false;
    if (latestStatus) renderRunner(latestStatus.runner);
  }
}

async function stopRunner() {
  const state = await api.stopRunner();
  if (latestStatus) latestStatus.runner = state;
  renderRunner(state);
  addLog("已请求停止 Runner。已有任务会由网站按失败/超时策略处理。");
}

$("refreshButton").addEventListener("click", refresh);
$("repairEnvironmentButton").addEventListener("click", prepareEnvironment);
$("heroPairButton").addEventListener("click", openPairing);
$("openPairingButton").addEventListener("click", openPairing);
$("topOpenSiteButton").addEventListener("click", openSite);
$("heroOpenSiteButton").addEventListener("click", openSite);
$("openSiteButton").addEventListener("click", openSite);
$("closePairingButton").addEventListener("click", closePairing);
$("cancelPairingButton").addEventListener("click", closePairing);
$("pairingForm").addEventListener("submit", submitPairing);
$("startButton").addEventListener("click", startRunner);
$("stopButton").addEventListener("click", stopRunner);
$("agent").addEventListener("change", () => {
  if (latestStatus) renderAgentAvailability(latestStatus.report);
});

api.onRunnerEvent((event) => {
  if (event.type === "output") addLog(`[${event.stream}] ${event.line}`);
  if (event.type === "started") addLog(`Runner 已启动，使用 ${event.agentLabel}。`);
  if (event.type === "stopped") addLog(`Runner 已停止（退出码 ${event.code ?? "未知"}）。`);
  if (event.type === "error") setMessage(event.message, true);
  if (["started", "stopped"].includes(event.type)) {
    api.runnerStatus().then((state) => {
      if (latestStatus) latestStatus.runner = state;
      renderRunner(state);
    });
  }
});

api.onEnvironmentEvent((event) => {
  if (event.type === "progress") $("environmentProgress").textContent = event.message;
  if (event.type === "complete" && event.status) renderStatus(event.status);
  if (event.type === "error") $("environmentProgress").textContent = `准备失败：${event.message}`;
});

refresh();
