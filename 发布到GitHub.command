#!/bin/bash
# ════════════════════════════════════════════════════════════════
#  精读 LexiRead · 一键发布到 GitHub Pages
#
#  用法：在「访达」里双击这个文件就行（首次可能要右键 → 打开）。
#  它会：
#    1. 需要的话先让你登录 GitHub（码会显示在这个窗口里，当场就能用）
#    2. 建一个公开仓库 lexi-read
#    3. 把代码推上去
#    4. 打开 GitHub Pages
#    5. 等它上线并验证，最后把网址给你、自动用浏览器打开
# ════════════════════════════════════════════════════════════════

set -uo pipefail
cd "$(dirname "$0")" || exit 1

BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf "%s\n" "$*"; }
ok()   { printf "${GREEN}✓${OFF} %s\n" "$*"; }
warn() { printf "${YELLOW}!${OFF} %s\n" "$*"; }
die()  { printf "${RED}✗ %s${OFF}\n" "$*"; say ""; say "按回车键关闭…"; read -r _; exit 1; }

say ""
say "${BOLD}精读 LexiRead · 发布到 GitHub Pages${OFF}"
say "${DIM}────────────────────────────────────────────${OFF}"
say ""

# ── 1. 找到或准备好 gh（GitHub 官方命令行） ──────────────────────
GH=""
for c in \
  "$(command -v gh 2>/dev/null || true)" \
  "../.tools/gh_2.102.0_macOS_arm64/bin/gh" \
  "$HOME/Library/Application Support/LexiReadTools/gh_2.102.0_macOS_arm64/bin/gh" \
  "/opt/homebrew/bin/gh" "/usr/local/bin/gh"
do
  if [ -n "$c" ] && [ -x "$c" ]; then GH="$c"; break; fi
done

if [ -z "$GH" ]; then
  say "本机没有 GitHub 命令行工具，正在自动下载（约 14 MB，只下一次）…"
  TOOLS="$HOME/Library/Application Support/LexiReadTools"
  mkdir -p "$TOOLS" || die "创建 $TOOLS 失败"
  VER="2.102.0"
  URL="https://github.com/cli/cli/releases/download/v${VER}/gh_${VER}_macOS_arm64.zip"
  curl -fL --progress-bar -o "$TOOLS/gh.zip" "$URL" || die "下载失败，检查一下网络"
  (cd "$TOOLS" && unzip -oq gh.zip && rm -f gh.zip) || die "解压失败"
  GH="$TOOLS/gh_${VER}_macOS_arm64/bin/gh"
  [ -x "$GH" ] || die "没找到解压后的 gh"
  ok "工具已就绪"
fi

# ── 2. 登录 GitHub ────────────────────────────────────────────
if ! "$GH" auth status >/dev/null 2>&1; then
  say ""
  say "${BOLD}需要先登录一次 GitHub${OFF}"
  say "下面会显示一个 ${BOLD}8 位验证码${OFF}，并自动打开浏览器。"
  say "在浏览器里输入这个码、点授权，这个窗口就会自动继续。"
  say ""
  sleep 2
  "$GH" auth login --hostname github.com --git-protocol https --web --skip-ssh-key || die "登录失败"
fi

USER="$("$GH" api user --jq .login 2>/dev/null)"
[ -n "$USER" ] || die "拿不到 GitHub 用户名，请重新运行"
ok "已登录：${BOLD}$USER${OFF}"

# ── 3. 仓库名 ────────────────────────────────────────────────
REPO="lexi-read"
say ""
printf "仓库名用 ${BOLD}%s${OFF} 可以吗？（直接回车＝可以，或输入别的名字）：" "$REPO"
read -r ans
[ -n "${ans:-}" ] && REPO="$ans"
REPO="$(printf '%s' "$REPO" | tr -cd 'A-Za-z0-9._-')"
[ -n "$REPO" ] || die "仓库名不合法"

# ── 4. 建仓库 ────────────────────────────────────────────────
if "$GH" repo view "$USER/$REPO" >/dev/null 2>&1; then
  warn "仓库 $USER/$REPO 已存在，直接往上推"
else
  "$GH" repo create "$REPO" --public \
    --description "精读 LexiRead · AI 英文精读 + 语境记单词（PWA，iPhone/iPad/Mac 三端通用，用自己的 API Key，无订阅）" \
    --disable-wiki >/dev/null || die "创建仓库失败（名字可能被占用，换一个再试）"
  ok "已创建公开仓库 $USER/$REPO"
fi

# ── 5. 提交并推送 ────────────────────────────────────────────
say "正在推送代码…"
git add -A >/dev/null 2>&1
if ! git diff --cached --quiet 2>/dev/null; then
  git -c user.name="$USER" -c user.email="$USER@users.noreply.github.com" \
      commit -q -m "更新" >/dev/null || true
fi
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/$USER/$REPO.git"
git push -u origin main --force >/dev/null 2>&1 || git push -u origin master --force || die "推送失败"
ok "代码已推送"

# ── 6. 打开 GitHub Pages ─────────────────────────────────────
if "$GH" api "repos/$USER/$REPO/pages" >/dev/null 2>&1; then
  ok "GitHub Pages 已经是开启状态"
else
  "$GH" api -X POST "repos/$USER/$REPO/pages" \
      -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
    && ok "已开启 GitHub Pages" \
    || warn "自动开启 Pages 失败，请在仓库 Settings → Pages 里把 Branch 选成 main / (root)"
fi

URL="https://$USER.github.io/$REPO/"
say ""
say "${BOLD}════════════════════════════════════════════${OFF}"
say "${BOLD}  你的网址： $URL${OFF}"
say "${BOLD}════════════════════════════════════════════${OFF}"
say ""
say "${DIM}首次构建通常要 1～3 分钟，我在这儿等它生效…${OFF}"

for i in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 "$URL" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    ok "已经上线了！"
    say ""
    for f in index.html src/app.js src/sync.js config.js data/dict.json icons/icon-192.png; do
      c="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 "${URL}${f}" 2>/dev/null || echo 000)"
      if [ "$c" = "200" ]; then ok "$f"; else warn "$f  → $c"; fi
    done
    say ""
    say "${BOLD}接下来：${OFF}"
    say "  1. iPhone / iPad：用 Safari 打开上面的网址 → 分享 → 添加到主屏幕"
    say "  2. Mac：用 Safari 打开 → 文件 → 添加到程序坞"
    say "  3. 在应用里「设置 → AI 引擎」填上你自己的 DeepSeek API Key"
    say ""
    open "$URL" 2>/dev/null || true
    say "已经帮你用浏览器打开了。"
    say ""
    say "按回车键关闭…"; read -r _
    exit 0
  fi
  printf "  %s 第 %d 次…\n" "$code" "$i"
  sleep 6
done

warn "还没生效。去 https://github.com/$USER/$REPO/actions 看看构建进度，通常再等一会儿就好。"
say "网址依然是： $URL"
say ""
say "按回车键关闭…"; read -r _
