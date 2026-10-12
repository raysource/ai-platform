#!/usr/bin/env bash
# ============================================================
# 验收总入口
#   bash tools/run_all.sh           离线：状态机单测 + HTTP 端到端（sim 通道）
#   bash tools/run_all.sh --live    追加真实模型端到端（需要 API Key + 网络）
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."
export AI_PLATFORM_PROVIDER=sim
export AI_PLATFORM_SPEED=0

echo "== [1/4] 状态机单测 (node --test) =="
TEST_OUT=$(node --test test/ 2>&1)
echo "$TEST_OUT" | grep -E '^(✔|✖|ℹ (tests|pass|fail))' | sed 's/^/   /'
if echo "$TEST_OUT" | grep -qE 'ℹ fail 0'; then
  UNIT_N=$(echo "$TEST_OUT" | grep -oE 'ℹ pass [0-9]+' | grep -oE '[0-9]+')
  echo "   → 单测 $UNIT_N 条全绿"
else
  echo "$TEST_OUT" | sed -n '/failing tests/,$p'
  echo "   → 单测存在失败"; exit 1
fi

echo
echo "== [2/4] HTTP 端到端 · 离线通道 (node tools/e2e.mjs) =="
E2E_OUT=$(node tools/e2e.mjs 2>&1); E2E_RC=$?
echo "$E2E_OUT"
P=$(printf '%s' "$E2E_OUT" | grep -oE 'PASS=[0-9]+' | tail -1 | grep -oE '[0-9]+')
F=$(printf '%s' "$E2E_OUT" | grep -oE 'FAIL=[0-9]+' | tail -1 | grep -oE '[0-9]+')
P=${P:-0}; F=${F:-1}
if [ "$E2E_RC" -ne 0 ] || [ "$F" -ne 0 ]; then
  echo "RESULT: FAIL  (端到端 PASS=${P} FAIL=${F})"; exit 1
fi

echo
echo "== [3/4] 浏览器 UI 检查 · 源码目录树 (node tools/ui_tree.mjs) =="
UI_OUT=$(node tools/ui_tree.mjs 2>&1); UI_RC=$?
echo "$UI_OUT"
if echo "$UI_OUT" | grep -q '^SKIP'; then
  echo "   → UI 检查跳过（未装 Chrome）"
elif [ "$UI_RC" -ne 0 ]; then
  echo "   → UI 检查失败"; exit 1
else
  echo "   → UI 检查通过（$(echo "$UI_OUT" | grep -oE 'PASS=[0-9]+' | tail -1)）"
fi

if [ "${1:-}" = "--live" ]; then
  echo
  echo "== [4/4] 真实模型端到端 (node tools/e2e_live.mjs) =="
  LIVE_OUT=$(node tools/e2e_live.mjs 2>&1); LIVE_RC=$?
  echo "$LIVE_OUT"
  LP=$(printf '%s' "$LIVE_OUT" | grep -oE 'PASS=[0-9]+' | tail -1 | grep -oE '[0-9]+')
  LF=$(printf '%s' "$LIVE_OUT" | grep -oE 'FAIL=[0-9]+' | tail -1 | grep -oE '[0-9]+')
  LP=${LP:-0}; LF=${LF:-1}
  [ "$LIVE_RC" -ne 0 ] || [ "$LF" -ne 0 ] && { echo "RESULT: FAIL  (真实模型端到端 PASS=${LP} FAIL=${LF})"; exit 1; }
  echo
  echo "RESULT: PASS  (单测 ${UNIT_N} + 离线端到端 ${P} + UI 检查 + 真实模型端到端 ${LP}，FAIL=0)"
  exit 0
fi

echo
echo "RESULT: PASS  (单测 ${UNIT_N} + 离线端到端 ${P} + UI 检查，FAIL=0；真实模型端到端用 --live 追加)"
exit 0
