export function shouldHideToTray(isQuitting = false) {
  return !Boolean(isQuitting);
}

export function trayRunnerLabel(runner = {}) {
  return runner.running ? "Runner 运行中" : "Runner 未启动";
}
