# Codex Modeling Center Bridge

给朋友接入私有云建模中心的跨平台本地程序。Mac 和 Windows 共用同一套 Node.js 代码，设备各自使用自己的 Codex/ChatGPT 登录状态和额度；网站只负责私有任务队列、状态和交付文件。

## 能做什么

- 在 macOS 或 Windows 上一键引导 Python 虚拟环境和 CadQuery/OpenCascade 建模依赖。
- 从网站领取任务，在本机拉起真正的 Codex SDK 会话。
- 每个网站任务对应一个本地 Codex thread；线程 ID 保存在任务目录，可用 `sessions` 查看、用 `resume` 继续。
- 生成 STEP、参数化脚本、验证报告和脱敏的本地对话摘要，并上传到网站私有交付区。
- 多台 Mac/Windows 同时在线时共享队列；服务器原子领取任务，设备离线不会让任务凭空完成。
- 支持 `pull` 单次拉取和 `start --concurrency N` 多槽位运行。

## 额度与登录边界

这不是 API 代理，也不会共享你的 ChatGPT 登录。Codex SDK 默认调用本机 Codex CLI，并继承该设备已有的 Codex 登录状态，所以：

- 你的 Mac 使用你当前登录的 ChatGPT/Codex 额度。
- 朋友的 Windows 或 Mac 使用朋友在该设备登录的账户额度。
- 不要在运行 Runner 的终端设置 `OPENAI_API_KEY`；程序检测到它会警告，因为那可能切换成 API 计费路径。
- 配对的站点桥接授权和 Runner token 只写入 macOS Keychain 或 Windows 当前用户 DPAPI；不会写入 Git、任务对话或上传文件。
- 程序只同步“网站任务对应的本地线程”，不会扫描或上传用户全部 `~/.codex/sessions`。

## 新设备安装

安装脚本会优先使用已有 Node.js 24+；如果设备完全没有 Node.js，就把固定版本的官方 Node.js 24 运行时下载到当前用户目录并校验 SHA-256，不写入系统目录、不要求管理员权限。随后脚本创建独立 Python 3.11+ 虚拟环境并安装 CadQuery。首次安装需要网络访问和明确的 `--yes` 确认。

建模桥不会代替用户登录 Codex。新设备还需要按 [OpenAI 官方 Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli) 安装并首次运行 `codex`，在设备上完成自己的 ChatGPT 登录；不会复制任何现有设备的登录状态、Cookie 或 `~/.codex` 数据。

### macOS

```bash
git clone <你的新 GitHub 仓库地址>
cd codex-modeling-center-bridge
chmod +x scripts/install-macos.sh
./scripts/install-macos.sh
```

### Windows PowerShell

```powershell
git clone <你的新 GitHub 仓库地址>
Set-Location codex-modeling-center-bridge
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows.ps1
```

安装脚本会运行 `npm ci`，准备用户目录 Node 运行时，然后创建独立 Python 环境并安装 CadQuery。macOS 没有 Python 3.11+ 时会尝试使用已有 Homebrew；Windows 会尝试使用已有 WinGet。首次安装可能需要网络、系统包管理器或用户确认。

也可以分步执行：

```bash
node src/cli.mjs doctor
node src/cli.mjs bootstrap --yes
```

如果 `doctor` 报告缺少 Codex CLI，请先在本机安装并运行一次 `codex` 完成登录，再重新运行 `onboard`。脚本不会接触其他设备的 Codex 登录缓存。

## 从网站配对

1. 在私有网站登录后生成 Runner 配对码。
2. 复制“站点桥接授权”到本机终端；不要把它发到聊天、Issue 或 Git。
3. 在设备上运行下面的对应命令。

macOS：

```bash
export OAI_SITES_BYPASS_TOKEN="从网站复制的桥接授权"
node src/cli.mjs pair \
  --site https://你的站点地址 \
  --code 网站显示的8位配对码 \
  --site-auth "$OAI_SITES_BYPASS_TOKEN" \
  --name "我的 Mac Codex"
node src/cli.mjs start
```

Windows PowerShell：

```powershell
$env:OAI_SITES_BYPASS_TOKEN = "从网站复制的桥接授权"
node src/cli.mjs pair `
  --site https://你的站点地址 `
  --code 网站显示的8位配对码 `
  --site-auth $env:OAI_SITES_BYPASS_TOKEN `
  --name "我的 Windows Codex"
node src/cli.mjs start
```

也可以把安装、配对和启动合并成一条引导流程：

```bash
node src/cli.mjs onboard --install --yes \
  --site https://你的站点地址 \
  --code 网站显示的8位配对码 \
  --site-auth "$OAI_SITES_BYPASS_TOKEN" \
  --start
```

## 本地会话

```bash
node src/cli.mjs pull
node src/cli.mjs sessions
node src/cli.mjs resume <任务ID> --message "继续验证模型并修复报告中的问题"
```

`pull` 只领取一条任务并执行；长期运行用 `start`。每台机器默认一个并发槽位，只有在本机资源足够时才增加 `--concurrency 2` 等参数。

可选模型设置通过命令行传给本地 Codex，不写入站点：

```bash
node src/cli.mjs start --model <本机可用模型> --reasoning-effort high
```

不指定时保留本机 Codex 默认模型和推理强度。

## 文件布局

本机状态位于用户数据目录，而不是仓库：

- macOS：`~/Library/Application Support/CodexModelingCenter/`
- Windows：`%LOCALAPPDATA%\CodexModelingCenter\`

其中工作区保存每个任务的 `REQUEST.md`、`AGENTS.md`、`session.json`、脱敏的 `artifacts/conversation.md` 和原始本地 `events.jsonl`。原始事件只留在本机；网站只上传交付目录中的模型、脚本、验证报告和对话摘要。

## 安全模型

这个程序拥有在本机任务工作区运行 Codex 的权限。朋友安装前应确认代码来源和 Git 提交；不要以管理员身份运行，除非操作系统的依赖安装明确要求。站点配对码一次性、短时有效；撤销设备时从网站删除/停用对应 Runner，并删除本机配置目录。
