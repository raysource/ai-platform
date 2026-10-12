#!/usr/bin/env bash
# 把上游 addyosmani/agent-skills 拉一份到 vendor/agent-skills/（钉住 commit），并记下 SHA。
# 只拉一次；之后平台完全离线读 vendor 目录，不在运行时联网。
#   bash tools/vendor_agent_skills.sh          # 缺则克隆，已有则不动
#   bash tools/vendor_agent_skills.sh --update # 强制重拉
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=vendor/agent-skills
REPO=https://github.com/addyosmani/agent-skills.git

if [ "${1:-}" = "--update" ]; then rm -rf "$DEST"; fi
if [ -f "$DEST/SOURCE" ]; then
  echo "已存在：$DEST（$(cat "$DEST/SOURCE" | tr '\n' ' ')）；要更新用 --update"
  exit 0
fi
mkdir -p vendor
git clone --depth 1 --quiet "$REPO" "$DEST"
SHA=$(git -C "$DEST" rev-parse HEAD)
# 外层仓库要把它当普通内容提交，别留嵌套 .git（否则外层只记一个 gitlink、克隆出来是空目录）
rm -rf "$DEST/.git"
printf 'repo: %s\nsha: %s\ndate: %s\n' "$REPO" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEST/SOURCE"
echo "已克隆 → $DEST"
echo "SHA $SHA"
ls "$DEST/skills" | wc -l | xargs echo "SKILL.md 数："
