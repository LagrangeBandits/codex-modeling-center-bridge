$ErrorActionPreference = "Stop"

# Keep the runtime under the current user's LocalAppData. No administrator
# installation is required for the bridge itself.
$nodeVersion = "24.19.0"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeBin = $null
if ($null -ne $nodeCommand) {
  $systemMajor = [int]((& $nodeCommand.Source -p 'Number(process.versions.node.split(".")[0])').Trim())
  if ($systemMajor -ge 24) {
    $nodeBin = $nodeCommand.Source
  }
}

if ($null -eq $nodeBin) {
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($architecture -eq "arm64") {
    $nodeArch = "arm64"
    $nodeSha256 = "8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f"
  } else {
    $nodeArch = "x64"
    $nodeSha256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
  }

  $runtimeRoot = Join-Path $env:LOCALAPPDATA "CodexModelingCenter\runtime"
  $runtimeDirectory = Join-Path $runtimeRoot "node-v$nodeVersion-win-$nodeArch"
  $nodeBin = Join-Path $runtimeDirectory "node.exe"
  $archiveName = "node-v$nodeVersion-win-$nodeArch.zip"
  $archivePath = Join-Path $runtimeRoot $archiveName
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

  if (-not (Test-Path -LiteralPath $nodeBin)) {
    if (-not (Test-Path -LiteralPath $archivePath)) {
      Invoke-WebRequest -UseBasicParsing -MaximumRedirection 5 `
        -Uri "https://nodejs.org/dist/v$nodeVersion/$archiveName" `
        -OutFile $archivePath
    }
    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $nodeSha256) {
      throw "Node.js 下载校验失败：$archiveName；期望 $nodeSha256，实际 $actualSha256"
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
  }
}

if (-not (Test-Path -LiteralPath $nodeBin)) {
  throw "未找到可用的 Node.js 24+ 运行时。"
}

$nodeDirectory = Split-Path -Parent $nodeBin
$env:Path = "$nodeDirectory;$env:Path"
$nodeMajor = [int]((& $nodeBin -p 'Number(process.versions.node.split(".")[0])').Trim())
if ($nodeMajor -lt 24) {
  throw "当前 Node.js 版本低于 24。"
}

& npm ci --ignore-scripts
& node src/cli.mjs onboard --install --yes @args
