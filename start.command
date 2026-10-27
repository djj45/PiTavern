#!/bin/bash
# macOS 可双击运行；也可在终端执行 ./start.command 或 npm start。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
# Finder 启动的终端可能没有加载 Homebrew 的路径；保留用户已有的 Node 优先级。
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin"
SERVER_PID=""

cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    printf '\n正在停止 PiTavern…\n'
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ "$status" -ne 130 ] && [ "$status" -ne 143 ] && [ -t 0 ]; then
    printf '\n启动失败，请查看上方错误。按回车关闭窗口。'
    read -r _ || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

fail() {
  printf '\n错误：%s\n' "$1" >&2
  exit 1
}

printf '\n🍺 PiTavern 一键启动\n项目：%s\n\n' "$PROJECT_DIR"

command -v node >/dev/null 2>&1 || fail "未找到 Node.js，请先安装 Node.js 22.19 或更高版本。"
command -v npm >/dev/null 2>&1 || fail "未找到 npm，请检查 Node.js 安装。"
command -v curl >/dev/null 2>&1 || fail "未找到 curl，无法检查服务是否就绪。"
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  fail "当前 Node.js $(node --version) 不符合要求，需要 22.19 或更高版本。"
fi

# 与服务端一致：PORT 环境变量 > 配置中的 port > 默认 8787。
# 配置相对路径以仓库根目录为基准，不输出含 API Key 的配置内容。
if ! APP_PORT="$(node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const file = path.resolve(process.env.PITAVERN_CONFIG ?? 'data/config.json');
let config = {};
try {
  if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  console.error(`无法读取配置，请检查文件权限和 JSON 格式：${file}`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? config?.port ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('启动端口必须是 1～65535 的整数。');
  process.exit(1);
}
console.log(port);
NODE
)"; then
  fail "无法确定启动端口。"
fi
APP_URL="http://127.0.0.1:$APP_PORT"

if ! node --input-type=module - "$APP_PORT" <<'NODE'
import net from 'node:net';
const probe = net.createServer();
probe.once('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${process.argv[2]} 已被占用。若酒馆已经启动，请访问 http://127.0.0.1:${process.argv[2]}；否则设置 PORT 使用其他端口。`
    : `无法监听端口 ${process.argv[2]}（${error.code}）。`);
  process.exitCode = 1;
});
probe.listen(Number(process.argv[2]), '127.0.0.1', () => probe.close());
NODE
then
  fail "端口不可用。"
fi

printf '[1/3] 检查依赖…\n'
if ! npm ls --depth=0 --include=dev >/dev/null 2>&1; then
  printf '安装项目依赖（首次启动需要联网）…\n'
  npm ci --include=dev || fail "依赖安装失败，请检查网络及 npm 错误信息后重试。"
fi

printf '\n[2/3] 构建前端…\n'
npm run build || fail "前端构建失败。"

printf '\n[3/3] 启动服务…\n'
# 直接管理 Node 进程，停止启动器时可以回收本次服务，不留下 npm 子进程。
PORT="$APP_PORT" node --import tsx apps/server/src/index.ts &
SERVER_PID=$!

READY=0
for ((attempt = 0; attempt < 60; attempt++)); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    fail "服务已退出，请查看上方日志。"
  fi
  if curl --noproxy '*' --fail --silent --max-time 1 "$APP_URL/api/status" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done
[ "$READY" -eq 1 ] || fail "等待服务就绪超时。"

printf '\n启动成功：%s\n关闭此窗口或按 Ctrl+C 停止服务。\n\n' "$APP_URL"
if [ "${PITAVERN_OPEN_BROWSER:-1}" != "0" ]; then
  if [ "$(uname -s)" = "Darwin" ] && command -v open >/dev/null 2>&1; then
    open "$APP_URL" || printf '浏览器未自动打开，请手动访问上方地址。\n'
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$APP_URL" >/dev/null 2>&1 || printf '浏览器未自动打开，请手动访问上方地址。\n'
  fi
fi

wait "$SERVER_PID"
