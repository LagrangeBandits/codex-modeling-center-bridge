# 新设备交接清单

给朋友或另一台设备使用时，按这个顺序交接：

1. 从公开 GitHub 仓库克隆本程序。
2. macOS 运行 `./scripts/install-macos.sh`，Windows 运行 `Set-ExecutionPolicy -Scope Process Bypass; .\scripts\install-windows.ps1`；脚本会在没有 Node 时准备用户目录 Node 24，并创建 Python 3.11+ / CadQuery 环境。
3. 选择本机 Agent：
   - `codex`：设备使用者自己安装 Codex CLI，并完成自己的 ChatGPT/Codex 登录。
   - `claude`：设备使用者自己安装 Claude Code，并完成自己的本地登录；不复制其他设备的认证目录。
4. 要使用桌面程序，运行 `npm run desktop:dev`；正式安装包由目标平台分别执行 `npm run desktop:dist` 生成。也可以继续使用 CLI 完成引导。
5. 在云端建模系统生成一次性配对码，并在当前设备的“连接至云端建模系统”临时窗口填入桥接授权；CLI 用户通过 `--site-auth` 或临时环境变量传入。配对完成后可使用“一键前往建模网站”。
6. 确认 `doctor` 或桌面状态显示 Node 24+、Python 3.11+、CadQuery 和所选 Agent 已就绪。
7. 回到网站确认设备状态为在线，再提交一个小型测试任务。
8. 测试成功后，用桌面程序启动 Runner，或用 `start` 保持设备在线；需要只拉一条任务时用 `pull`。
9. 如网站启用任务优先级、方案确认或取消，确认 Runner 心跳能力中包含 `task:cancel`、`task:priority` 和 `bridge:messages`；旧版网站缺少这些可选接口时仍可正常领取和完成普通任务。
10. 正式安装包启动后会延迟检查公开 GitHub Release；更新不会自动下载。只有在“软件更新”区域分别确认“下载更新”和“重启并安装”才会改变版本，Runner 运行时安装按钮会保持不可用。
11. 升级异常时保留旧版本安装包和独立备份；本次发布保留 `v0.1.9` 作为回滚版本，不删除 Keychain、DPAPI、Harness 或本地状态目录。

Claude 的 Windows 注意事项：Claude Code 原生 Windows 不提供与 macOS/Linux 相同的内置沙箱；要在 Windows 上无人值守使用 Claude Agent，应先准备 WSL2。若不准备 WSL2，可选择 Codex 作为 Windows 本机 Agent。程序不会为了绕过沙箱而自动降级到无保护执行。

不要做这些事：

- 不要把 Mac 的 `~/.codex`、Windows 的 Codex 登录目录、Claude 登录目录、`config.json` 或 `secrets.json` 复制给另一台设备。
- 不要把桥接授权或 Runner token 写入 README、Issue、GitHub Actions 日志或聊天。
- 不要同时以管理员身份运行整个 Runner；只有系统依赖安装步骤在需要时接受系统确认。
- 不要让多个设备共享同一个本地工作区；每台设备使用自己的默认工作区。
- 不要把一台设备的本地 Agent 会话、`events.jsonl` 或任务目录复制到另一台设备；跨设备只同步网站任务和允许上传的交付文件。

任务交接时同时记录：任务 ID、网站优先级、`direct`/`plan` 模式、选定 Agent、模型偏好、当前本地会话是否存在、最近一次 Runner 状态和待确认的几何假设。取消任务后保留任务目录用于诊断，不要删除 Keychain、DPAPI、Harness 或独立回滚备份。
