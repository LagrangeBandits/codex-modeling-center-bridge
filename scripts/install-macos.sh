#!/bin/sh
set -eu

# Keep the runtime user-scoped: a new device does not need an administrator
# password just to start the bridge. The release and SHA-256 values are pinned
# so a proxy cannot silently substitute a different Node binary.
node_version="24.19.0"
node_bin="$(command -v node || true)"
node_major="0"
if [ -n "$node_bin" ]; then
  node_major="$($node_bin -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
fi

if [ "$node_major" -lt 24 ] 2>/dev/null; then
  case "$(uname -m)" in
    arm64)
      node_arch="darwin-arm64"
      node_sha256="8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
      ;;
    x86_64)
      node_arch="darwin-x64"
      node_sha256="d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316"
      ;;
    *)
      echo "暂不支持此 macOS 架构：$(uname -m)" >&2
      exit 1
      ;;
  esac

  user_runtime_root="$HOME/Library/Application Support/CodexModelingCenter/runtime"
  runtime_directory="$user_runtime_root/node-v${node_version}-${node_arch}"
  node_bin="$runtime_directory/bin/node"
  archive_name="node-v${node_version}-${node_arch}.tar.gz"
  archive_path="$user_runtime_root/$archive_name"
  mkdir -p "$user_runtime_root"

  if [ ! -x "$node_bin" ]; then
    if [ ! -f "$archive_path" ]; then
      curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
        --output "$archive_path" \
        "https://nodejs.org/dist/v${node_version}/${archive_name}"
    fi
    actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
    if [ "$actual_sha256" != "$node_sha256" ]; then
      echo "Node.js 下载校验失败：$archive_name" >&2
      echo "期望：$node_sha256" >&2
      echo "实际：$actual_sha256" >&2
      exit 1
    fi
    tar -xzf "$archive_path" -C "$user_runtime_root"
  fi
fi

if [ ! -x "$node_bin" ]; then
  echo "未找到可用的 Node.js 24+ 运行时。" >&2
  exit 1
fi

export PATH="$(dirname "$node_bin"):$PATH"
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 24 ]; then
  echo "当前 Node.js 版本低于 24，请升级或删除用户目录运行时后重试。" >&2
  exit 1
fi

npm ci --ignore-scripts
node src/cli.mjs onboard --install --yes "$@"
