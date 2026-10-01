#!/usr/bin/env bash
# 把精读 LexiRead 发布到 GitHub Pages
# 用法: bash scripts/release_github.sh [仓库名]
set -euo pipefail

GH="/Users/michael/Documents/deepseek-harness/default-workspace/.tools/gh_2.102.0_macOS_arm64/bin/gh"
REPO="${1:-lexi-read}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▸ 检查登录状态…"
"$GH" auth status >/dev/null 2>&1 || { echo "✗ 还没登录 GitHub"; exit 1; }
USER="$("$GH" api user --jq .login)"
echo "  已登录：$USER"

echo "▸ 创建公开仓库 $USER/$REPO …"
if "$GH" repo view "$USER/$REPO" >/dev/null 2>&1; then
  echo "  仓库已存在，直接推"
else
  "$GH" repo create "$REPO" --public \
    --description "精读 LexiRead · AI 英文精读 + 语境记单词（PWA，iPhone/iPad/Mac 三端通用，自带 API Key 不订阅）" \
    --disable-wiki
fi

echo "▸ 推送代码…"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$USER/$REPO.git"
git push -u origin main --force

echo "▸ 打开 GitHub Pages…"
if "$GH" api "repos/$USER/$REPO/pages" >/dev/null 2>&1; then
  echo "  Pages 已经开着"
else
  "$GH" api -X POST "repos/$USER/$REPO/pages" \
    -f "source[branch]=main" -f "source[path]=/" >/dev/null
  echo "  已开启"
fi

URL="https://$USER.github.io/$REPO/"
echo
echo "════════════════════════════════════════"
echo "  网址： $URL"
echo "════════════════════════════════════════"
echo
echo "▸ 等 GitHub 构建并验证（最多 3 分钟）…"
for i in $(seq 1 36); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 "$URL" || echo 000)"
  if [ "$code" = "200" ]; then
    echo "  ✓ 已上线（HTTP $code）"
    for f in index.html src/app.js src/sync.js config.js data/dict.json; do
      c="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 "${URL}${f}" || echo 000)"
      printf "    %-22s %s\n" "$f" "$c"
    done
    exit 0
  fi
  printf "  …等待中（%s，第 %d 次）\n" "$code" "$i"
  sleep 5
done
echo "  ⚠ 还没生效，可以去仓库的 Actions 页看构建进度"
