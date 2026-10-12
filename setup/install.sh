#!/usr/bin/env bash
# ============================================================
# ai-platform 安装 / 配置 / 启停 命令行工具
#   bash setup/install.sh <命令>
#     check      环境体检（默认）：Node/JDK/python3/Chrome/模型 Key/端口 —— 只读，缺硬条件退出码 1
#     install    装缺的可选工具链（brew；与 exec.mjs 的 installPlan 同一套）
#     configure  写 setup/ai-platform.env（端口 / 通道 / 模型 / Key / 数据与工作区路径）
#     verify     跑验收总入口 bash tools/run_all.sh [--live]
#     start      按配置后台起服务（写 run/<port>.pid 与 run/<port>.log）
#     stop       停掉自己起的服务（同时报残留实例数，不会盲目 pkill）
#     status     看进程 / 端口 / /api/state（项目数 · 通道 · 并发）
#     selftest   本脚本自己的断言自检（不起服务）
#     help
# 配置读取优先级：命令行 flag > 已存在的环境变量 > setup/ai-platform.env > 缺省值
# ============================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
SETUP="$DIR/setup"
ENV_FILE="$SETUP/ai-platform.env"
RUN_DIR="$SETUP/run"
NODE_MIN=20
NODE_UI_MIN=22          # 截图 / UI 检查用内建 WebSocket（tools/ui_tree.mjs），Node ≥ 22
CHROME_DEFAULT="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

C_OK=0; C_WARN=0; C_BAD=0

usage() {
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"    # 打印文件头的注释块（不写死行号）
}

# ---------- 输出 ----------
ok()   { printf '  \033[32m✓\033[0m %-12s %s\n' "$1" "$2"; C_OK=$((C_OK + 1)); }
warn() { printf '  \033[33m!\033[0m %-12s %s\n' "$1" "$2"; C_WARN=$((C_WARN + 1)); }
bad()  { printf '  \033[31m✗\033[0m %-12s %s\n' "$1" "$2"; C_BAD=$((C_BAD + 1)); }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# ---------- 配置 ----------
# 读配置文件：已存在的环境变量优先（`AI_PLATFORM_PORT=8899 install.sh start` 仍然生效）
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    k="$(printf '%s' "$k" | tr -d '[:space:]')"
    [ -n "$k" ] || continue
    if ! printenv "$k" >/dev/null 2>&1; then export "$k=$v"; fi
  done < "$ENV_FILE"
}

port()  { printf '%s' "${AI_PLATFORM_PORT:-8788}"; }
host()  { printf '%s' "${AI_PLATFORM_HOST:-127.0.0.1}"; }
base()  { printf 'http://%s:%s' "$(host)" "$(port)"; }
pidfile() { printf '%s/ai-platform-%s.pid' "$RUN_DIR" "$(port)"; }
logfile() { printf '%s/ai-platform-%s.log' "$RUN_DIR" "$(port)"; }
data_file() { printf '%s' "${AI_PLATFORM_DATA:-$DIR/data/projects.json}"; }

mask() { # 只回显前 4 位，永不打全 Key
  local k="$1"
  if [ "${#k}" -le 4 ]; then printf '****'; else printf '%s****(%d 位)' "$(printf '%s' "$k" | cut -c1-4)" "${#k}"; fi
}

# ---------- 探测（判定口径与 exec.mjs / agent.mjs 一致） ----------
node_bin() { command -v node 2>/dev/null; }
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

# exec.mjs findJava：JAVA_HOME → PATH → Homebrew keg；macOS 的 /usr/bin/javac 是桩，必须真跑 `javac -version` 才算
java_dir() {
  local d v
  for d in "${JAVA_HOME:-}/bin" "$(dirname "$(command -v javac 2>/dev/null || echo /nonexistent)")" \
           /opt/homebrew/opt/openjdk@21/bin /opt/homebrew/opt/openjdk/bin /opt/homebrew/opt/openjdk@25/bin \
           /opt/homebrew/opt/openjdk@27/bin /usr/local/opt/openjdk/bin; do
    if [ -x "$d/javac" ]; then
      v="$("$d/javac" -version 2>&1 || true)"
      case "$v" in javac\ *) printf '%s' "$d"; return 0 ;; esac
    fi
  done
  return 1
}
python_bin() { command -v python3 2>/dev/null || { [ -x /usr/bin/python3 ] && printf '/usr/bin/python3'; }; }
chrome_bin() { [ -n "${CHROME_PATH:-}" ] && { printf '%s' "$CHROME_PATH"; return; }; [ -x "$CHROME_DEFAULT" ] && printf '%s' "$CHROME_DEFAULT"; }
# agent.mjs loadKey：AI_PLATFORM_API_KEY → DEEPSEEK_API_KEY → ~/.hermes/.env
key_source() {
  [ -n "${AI_PLATFORM_API_KEY:-}" ] && { printf 'AI_PLATFORM_API_KEY'; return; }
  [ -n "${DEEPSEEK_API_KEY:-}" ] && { printf 'DEEPSEEK_API_KEY'; return; }
  if [ -f "$HOME/.hermes/.env" ] && grep -qE '^[[:space:]]*(DEEPSEEK|AI_PLATFORM)_API_KEY[[:space:]]*=' "$HOME/.hermes/.env"; then
    printf '~/.hermes/.env'
  fi
}
port_owner() { lsof -nP -iTCP:"$(port)" -sTCP:LISTEN -t 2>/dev/null | head -1; }
running_pid() { # pidfile 里的 pid 还活着才算
  local f; f="$(pidfile)"
  [ -f "$f" ] || return 1
  local p; p="$(cat "$f" 2>/dev/null || true)"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null && { printf '%s' "$p"; return 0; }
  return 1
}
instances() { pgrep -f 'node .*server\.mjs' 2>/dev/null | wc -l | tr -d ' '; }   # runbook 的血泪教训：别只看端口（用 pgrep 免得匹配到自己的 grep 命令行）

# ---------- check ----------
cmd_check() {
  step "环境体检 · $(basename "$DIR")"
  local n
  if n="$(node_bin)"; then
    local v; v="$("$n" -v)"
    if ver_ge "${v#v}" "$NODE_MIN"; then ok node "$v ($n)"; else bad node "$v < $NODE_MIN —— 升级：brew install node"; fi
    if ver_ge "${v#v}" "$NODE_UI_MIN"; then ok "node(UI)" "≥ ${NODE_UI_MIN}，UI 检查/截图可用"; else warn "node(UI)" "$v < ${NODE_UI_MIN} —— tools/ui_tree.mjs 会 SKIP（截图用内建 WebSocket）"; fi
  else
    bad node "未安装 —— brew install node（或 https://nodejs.org）"
  fi
  command -v npm >/dev/null 2>&1 && ok npm "$(npm -v)" || warn npm "未安装（npm start / npm run verify 不可用，node server.mjs 照跑）"

  local d
  if d="$(java_dir)"; then ok jdk "$("$d/javac" -version 2>&1 | tr -d '\n') ($d)"
  else warn jdk "没找到可用 JDK —— 只有 Java/CAP 项目真跑测试需要；缺时平台会自己 brew install openjdk@21"; fi
  local p
  if p="$(python_bin)"; then ok python3 "$("$p" -V 2>&1) ($p)"; else warn python3 "没找到 —— 只有 Python 项目真跑测试需要；缺时平台会自己 brew install python@3.12"; fi
  local c
  if c="$(chrome_bin)"; then ok chrome "$c"; else warn chrome "未找到 —— UI 检查与项目预览截图会 SKIP（只跑逻辑检查）"; fi
  command -v jq >/dev/null 2>&1 && ok jq "$(command -v jq)" || warn jq "未找到（只有 tools/vendor_agent_skills.sh 用到）"
  command -v cds >/dev/null 2>&1 && ok cds "$(command -v cds)" || warn cds "未找到 @sap/cds-dk —— CDS 只做结构性校验，不会谎称 cds compile"
  command -v git >/dev/null 2>&1 && ok git "$(git --version)" || warn git "未找到（只在重拉 vendor/agent-skills 时需要）"

  local ks; ks="$(key_source)"
  if [ -n "$ks" ] && [ "${AI_PLATFORM_PROVIDER:-live}" != sim ]; then ok "模型 Key" "来源 $ks —— 真实模型通道可用"
  elif [ "${AI_PLATFORM_PROVIDER:-live}" = sim ]; then warn "模型 Key" "当前是离线模板通道（AI_PLATFORM_PROVIDER=sim），不看 Key"
  else bad "模型 Key" "三处都没有（AI_PLATFORM_API_KEY / DEEPSEEK_API_KEY / ~/.hermes/.env）——真实阶段会明确失败，不会假装成功"
  fi

  local f="$ENV_FILE"
  [ -f "$f" ] && ok 配置文件 "${f}（$(grep -cE '^[A-Z]' "$f" 2>/dev/null || echo 0) 项）" || warn 配置文件 "$f 不存在 —— 跑 bash setup/install.sh configure 生成（不生成也能跑，全用缺省值）"
  local dd; dd="$(dirname "$(data_file)")"          # 体检只读：目录不存在就说「启动时自建」，不在这里写盘
  if [ ! -d "$dd" ]; then warn 状态目录 "${dd} 还不存在（start 时自建）"
  elif [ -w "$dd" ]; then ok 状态目录 "${dd}（$(data_file)）"
  else bad 状态目录 "${dd} 不可写"; fi
  local ws; ws="${AI_PLATFORM_WORKSPACE:-$DIR/workspace}"
  if [ ! -d "$ws" ]; then warn 工作区 "${ws} 还不存在（开发阶段自建）"
  elif [ -w "$ws" ]; then ok 工作区 "$ws"
  else bad 工作区 "${ws} 不可写"; fi

  local o; o="$(port_owner)"
  if [ -z "$o" ]; then ok "端口 $(port)" "空闲"
  elif [ "$o" = "$(running_pid 2>/dev/null || true)" ]; then ok "端口 $(port)" "本项目已在这个端口跑（pid ${o}）→ $(base)"
  else warn "端口 $(port)" "被 pid $o 占用 —— configure --port <别的端口> 换一个，或先停掉它"; fi

  local n_inst; n_inst="$(instances)"
  [ "$n_inst" -le 1 ] && ok 实例数 "$n_inst" || warn 实例数 "$n_inst 个 server.mjs 同时在跑（只有 1 个能绑端口，其余照写状态）—— 建议逐个停"
  step "小结"
  printf '  通过 %d · 提醒 %d · 阻塞 %d\n' "$C_OK" "$C_WARN" "$C_BAD"
  if [ "$C_BAD" -gt 0 ]; then printf '  → 硬条件未满足，先解决上面的 ✗ 再启动\n'; return 1; fi
  printf '  → 可启动：bash setup/install.sh start（随后 npm run verify 验收）\n'
}

# ---------- install ----------
cmd_install() {
  local dry=0
  [ "${1:-}" = "--dry-run" ] && dry=1
  step "安装缺失的工具链$( [ "$dry" = 1 ] && printf ' · dry-run')"
  local brew; brew="$(command -v brew || { [ -x /opt/homebrew/bin/brew ] && printf /opt/homebrew/bin/brew; })"
  local todo=0
  if ! node_bin >/dev/null 2>&1; then printf '  - node（必需）: brew install node\n'; todo=1; fi
  if ! java_dir >/dev/null 2>&1; then printf '  - JDK（Java/CAP 项目真跑测试）: %s\n' "${brew:+$brew }install openjdk@21"; todo=1; fi
  if ! python_bin >/dev/null 2>&1; then printf '  - python3（Python 项目真跑测试）: %s\n' "${brew:+$brew }install python@3.12"; todo=1; fi
  if ! chrome_bin >/dev/null 2>&1; then printf '  - Chrome（UI 检查 / 预览截图，可选）: %s\n' "${brew:+$brew }install --cask google-chrome"; todo=1; fi
  if [ "$todo" = 0 ]; then printf '  都装好了，不用动。\n'; return 0; fi
  [ -n "$brew" ] || { printf '\n  ✗ 没有 Homebrew，上面几条请手动装（或先装 brew：https://brew.sh）。装不上就照实报缺，平台不会假装跑过。\n'; return 1; }
  if [ "$dry" = 1 ]; then printf '\n  dry-run，未执行。去掉 --dry-run 即真装。\n'; return 0; fi
  printf '\n  用 %s 真装（表里没有的跳过）…\n' "$brew"
  node_bin >/dev/null 2>&1   || { printf '\n  $ %s install node\n' "$brew"; "$brew" install node || return 1; }
  java_dir >/dev/null || { printf '\n  $ %s install openjdk@21\n' "$brew"; "$brew" install openjdk@21 || return 1; }
  python_bin >/dev/null 2>&1 || { printf '\n  $ %s install python@3.12\n' "$brew"; "$brew" install python@3.12 || return 1; }
  chrome_bin >/dev/null 2>&1 || { printf '\n  $ %s install --cask google-chrome\n' "$brew"; "$brew" install --cask google-chrome || return 1; }
  printf '\n  装完复检：\n'; cmd_check
}

# ---------- configure ----------
cmd_configure() {
  local k v
  local -a set_pairs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --port|--host|--provider|--model|--base-url|--api-key|--data|--workspace|--concurrency)
        k="$1"; shift; [ $# -gt 0 ] || { printf '缺 %s 的值\n' "$k" >&2; return 2; }
        case "$k" in
          --port) set_pairs+=("AI_PLATFORM_PORT=$1") ;;
          --host) set_pairs+=("AI_PLATFORM_HOST=$1") ;;
          --provider) set_pairs+=("AI_PLATFORM_PROVIDER=$1") ;;
          --model) set_pairs+=("AI_PLATFORM_MODEL=$1") ;;
          --base-url) set_pairs+=("AI_PLATFORM_BASE_URL=$1") ;;
          --api-key) set_pairs+=("AI_PLATFORM_API_KEY=$1") ;;
          --data) set_pairs+=("AI_PLATFORM_DATA=$1") ;;
          --workspace) set_pairs+=("AI_PLATFORM_WORKSPACE=$1") ;;
          --concurrency) set_pairs+=("AI_PLATFORM_CONCURRENCY=$1") ;;
        esac
        shift ;;
      --show) [ -f "$ENV_FILE" ] && cat "$ENV_FILE" || printf '(还没有 %s)\n' "$ENV_FILE"; return 0 ;;
      *) printf '未知参数：%s\n' "$1" >&2; return 2 ;;
    esac
  done
  [ ${#set_pairs[@]} -gt 0 ] || { printf '用法：bash setup/install.sh configure [--port 8788] [--provider live|sim] [--model M] [--base-url U] [--api-key K] [--data PATH] [--workspace PATH] [--concurrency 1-8] [--show]\n'; return 2; }

  mkdir -p "$SETUP"
  local tmp="$ENV_FILE.tmp" old="$ENV_FILE.old" pair k2 skip
  [ -f "$ENV_FILE" ] && grep -vE '^(#|$)' "$ENV_FILE" > "$old" || : > "$old"
  {
    printf '# ai-platform 配置（bash setup/install.sh configure 生成，可手改；start/status/stop 会读它）\n'
    printf '# 已存在的环境变量优先于本文件 —— 见 setup/README.md 「配置优先级」\n'
    for pair in "${set_pairs[@]}"; do printf '%s\n' "$pair"; done          # 本次显式设置的排在最前
    while IFS= read -r line || [ -n "$line" ]; do                          # 其余原样保留（不重复、不丢）
      k2="${line%%=*}"; skip=0
      for pair in "${set_pairs[@]}"; do [ "${pair%%=*}" = "$k2" ] && skip=1; done
      [ "$skip" = 1 ] || printf '%s\n' "$line"
    done < "$old"
  } > "$tmp"
  rm -f "$old"; mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"                                          # 里面有 Key，别给人看
  step "已写 $ENV_FILE"
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in *API_KEY*) printf '  %s=%s\n' "$k" "$(mask "$v")" ;; *) printf '  %s=%s\n' "$k" "$v" ;; esac
  done < "$ENV_FILE"
  printf '  手动起服务时这样加载：set -a; . setup/ai-platform.env; set +a; node server.mjs\n'
}

# ---------- start / stop / status ----------
cmd_start() {
  local n; n="$(node_bin)" || { printf '✗ 没有 node，先 bash setup/install.sh install\n' >&2; return 1; }
  local o; o="$(port_owner)"
  if [ -n "$o" ]; then
    if [ "$o" = "$(running_pid 2>/dev/null || true)" ]; then printf '已在跑（pid %s）→ %s\n' "$o" "$(base)"; return 0; fi
    printf '✗ 端口 %s 被 pid %s 占用，换端口：bash setup/install.sh configure --port 8899\n' "$(port)" "$o" >&2; return 1
  fi
  mkdir -p "$RUN_DIR"
  local lf pf; lf="$(logfile)"; pf="$(pidfile)"
  : > "$lf"
  nohup "$n" server.mjs >> "$lf" 2>&1 &
  printf '%s' "$!" > "$pf"
  local i code
  for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$(base)/api/state" 2>/dev/null)"
    [ "$code" = 200 ] && break
    kill -0 "$(cat "$pf")" 2>/dev/null || break
    sleep 0.25
  done
  if [ "$code" = 200 ]; then
    printf '✓ 已启动 pid %s → %s   (pidfile %s · 日志 %s)\n' "$(cat "$pf")" "$(base)" "$pf" "$lf"
    head -1 "$lf" | sed 's/^/  /'
  else
    printf '✗ 起不来（HTTP %s），日志末尾：\n' "${code:-无响应}" >&2
    tail -15 "$lf" >&2; rm -f "$pf"; return 1
  fi
}

cmd_stop() {
  local pf; pf="$(pidfile)"
  local p; p="$(running_pid || true)"
  if [ -z "$p" ]; then
    printf 'pidfile 里没有活着的进程（%s）。\n' "$pf"
    local lk; lk="$(data_file).lock"
    if [ -f "$lk" ]; then
      printf '数据锁文件：%s\n  它记的 pid 若是别的实例：kill %s\n' "$(cat "$lk")" "$(sed -E 's/.*"pid":([0-9]+).*/\1/' "$lk")"
    fi
    printf '残留实例数 %s（>1 时逐个停：ps -ef | grep "[s]erver\\.mjs"）\n' "$(instances)"
    return 1
  fi
  kill -TERM "$p" 2>/dev/null
  local i
  for i in $(seq 1 40); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "$p" 2>/dev/null; then kill -9 "$p" 2>/dev/null; printf 'pid %s 不吃 SIGTERM，已 SIGKILL\n' "$p"; fi
  rm -f "$pf"
  printf '✓ 已停 pid %s（端口 %s 现在：%s）\n' "$p" "$(port)" "$(port_owner || echo 空闲)"
  printf '  残留实例数 %s\n' "$(instances)"
}

cmd_status() {
  local p o; p="$(running_pid || true)"; o="$(port_owner)"
  if [ -n "$p" ]; then printf '  进程       pid %s（本项目 pidfile 记的）\n' "$p"
  else printf '  进程       没按本工具的 pidfile 起（可能是手动 node server.mjs / npm start）\n'; fi
  if [ -n "$o" ]; then printf '  端口 %-5s pid %s 在听\n' "$(port)" "$o"
  else printf '  端口 %-5s 没人在听\n' "$(port)"; fi
  printf '  实例总数  %s\n' "$(instances)"
  printf '  数据/工作区  %s · %s\n' "$(data_file)" "${AI_PLATFORM_WORKSPACE:-$DIR/workspace}"
  local body; body="$(curl -s --max-time 3 "$(base)/api/state" 2>/dev/null)"
  if [ -z "$body" ]; then printf '  /api/state 无响应（服务没起或端口不是 %s）\n' "$(port)"; return 1; fi
  printf '%s' "$body" | "$(node_bin)" -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const j = JSON.parse(s);
        console.log("  服务      " + (j.channel?.channel === "sim" ? "离线模板通道" : `真实模型通道 ${j.channel?.provider||""} ${j.channel?.model||""}`));
        console.log(`  运行      ${j.runtime?.provider||"?"} · 并发 ${j.runtime?.concurrency ?? "?"}（${(j.runtime?.agents||[]).join(" ")}）`);
        console.log(`  项目      ${(j.projects||[]).length} 个 · 进行中 ${j.active ? "有" : "无"}`);
      } catch (e) { console.log("  (解析 /api/state 失败：" + e.message + ")"); process.exit(1); }
    });' || return 1
}

cmd_verify() { step "验收 · bash tools/run_all.sh ${1:-}"; bash "$DIR/tools/run_all.sh" "${1:-}"; }

# ---------- selftest ----------
cmd_selftest() {
  local fail=0 t
  t() { # t <名字> <期望> <实得>
    if [ "$2" = "$3" ]; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s（期望 %s，实得 %s）\n' "$1" "$2" "$3"; fail=1; fi
  }
  ver_ge 22.0.0 20 && t "ver_ge 22≥20" yes yes || t "ver_ge 22≥20" yes no
  ver_ge 18.1.0 20 || t "ver_ge 18<20" no no
  ver_ge 20.0.0 20 && t "ver_ge 20≥20（边界相等）" yes yes || t "ver_ge 20≥20（边界相等）" yes no
  t "mask 不打全 Key" "sk-a****(14 位)" "$(mask sk-abcdefghijk)"
  t "mask 短 Key" "****" "$(mask abc)"
  # 配置文件：已存在的环境变量优先
  local tmp; tmp="$(mktemp)"; printf 'AI_PLATFORM_PORT=9999\nAI_PLATFORM_PROVIDER=sim\n' > "$tmp"
  local saved="$ENV_FILE"; ENV_FILE="$tmp"
  export AI_PLATFORM_PORT=8899          # 已导出的环境变量应压过配置文件（bash 的 `VAR=x func` 是临时的，故显式 export）
  load_env
  t "环境变量优先于配置文件" "8899" "$AI_PLATFORM_PORT"
  t "配置文件补空值" "sim" "${AI_PLATFORM_PROVIDER:-}"
  t "改端口后 pidfile/log 跟着走" "$RUN_DIR/ai-platform-8899.pid" "$(pidfile)"
  unset AI_PLATFORM_PORT AI_PLATFORM_PROVIDER
  ENV_FILE="$saved"; rm -f "$tmp"
  t "缺省端口 8788" "8788" "$(port)"
  [ "$fail" = 0 ] && printf '\nselftest PASS\n' || { printf '\nselftest FAIL\n'; return 1; }
}

case "${1:-check}" in
  check)      cmd_check ;;
  install)    shift; cmd_install "${1:-}" ;;
  configure)  shift; cmd_configure "$@" ;;
  verify)     shift; cmd_verify "${1:-}" ;;
  start)      load_env; cmd_start ;;
  stop)       load_env; cmd_stop ;;
  status)     load_env; cmd_status ;;
  selftest)   cmd_selftest ;;
  help|-h|--help) usage ;;
  *)          printf '未知命令：%s\n\n' "$1" >&2; usage >&2; exit 2 ;;
esac
