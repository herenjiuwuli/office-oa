#!/usr/bin/env bash
# 通用主分支推送脚本（api-test-platform / office-oa / job-hunter 共用同一份）。
#
# 用法：  bash scripts/push-main.sh            # 试一遍三条通道，不行就退出
#         bash scripts/push-main.sh --wait     # 都失败就轮询等网络恢复（最多 30 分钟）
#
# 三个踩过的坑，别再踩：
#   1) PortableGit 的 bash 解析「带大写变量名的单行 unset」会报引号不匹配，
#      所以推送命令必须写在脚本文件里执行，不能直接粘到终端。
#   2) PortableGit 系统级 gitconfig 里 credential.helper=helper-selector，
#      它在 push 末尾的 store 阶段会卡住等交互 → push 永远「零输出、像卡死」，
#      **即使网络完全正常**。绕法：-c credential.helper= 清空，只留 GCM。
#      现象很有误导性（零输出 + 被 SIGTERM），用 GIT_TRACE=1 才看得出卡在哪。
#   3) curl 的探测结果**不能**用来判断通道通不通：实测过
#      「探测 200 但 push 报 Recv failure」和「探测 000 但 push 成功」两种。
#      所以本脚本不预筛，直接按顺序真推，**推完问远端 sha** 才算数。
#   通道顺序：直连 → 沙箱透明代理 1212 → Clash 7897。
set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "不在 git 仓库里"; exit 1; }
cd "$ROOT" || exit 1

NAME=$(basename "$ROOT")
ORIGIN=$(git remote get-url origin 2>/dev/null) || ORIGIN=""
OWNER=$(printf '%s' "$ORIGIN" | sed -E 's#.*github\.com[:/]([^/]+)/.*#\1#')
[ -n "$OWNER" ] && [ "$OWNER" != "$ORIGIN" ] || OWNER="herenjiuwuli"
LOCAL_SHA=$(git rev-parse HEAD)

if [ -z "$ORIGIN" ]; then
  echo "还没配 origin。先在 GitHub 网页建仓库（30 秒）："
  echo "    1) 打开 https://github.com/new"
  echo "    2) Repository name 填：$NAME"
  echo "    3) 选 Public；不要勾 Add README / .gitignore / license（保持空仓库）"
  echo "    4) 建好后执行："
  echo "         git remote add origin https://github.com/$OWNER/$NAME.git"
  echo "       然后再跑一次本脚本"
  exit 1
fi

WAIT=0
[ "${1:-}" = "--wait" ] && WAIT=1

echo "仓库 $OWNER/$NAME"
echo "本地 HEAD = $LOCAL_SHA"

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY >/dev/null 2>&1

# 绕开会卡死的 helper-selector：清空 helper 列表，只留 GCM
GCM="$(git --exec-path)/../../bin/git-credential-manager.exe"
if [ -f "$GCM" ]; then
  CRED=(-c credential.helper= -c "credential.helper=!\"$GCM\"")
else
  CRED=()
  echo "（没找到 GCM，沿用系统 credential 配置）"
fi

remote_sha() {  # 直接问 GitHub API，不信 git 的本地记录；三条通道轮着取
  local url="https://api.github.com/repos/$OWNER/$NAME/git/refs/heads/main" raw="" p
  for p in "" "http://127.0.0.1:1212" "http://127.0.0.1:7897"; do
    if [ -z "$p" ]; then
      raw=$(curl -s --noproxy "*" --connect-timeout 10 --retry 2 "$url" 2>/dev/null)
    else
      raw=$(curl -s --proxy "$p" --connect-timeout 10 --retry 2 "$url" 2>/dev/null)
    fi
    [ -n "$raw" ] && break
  done
  printf '%s' "$raw" | grep -o '"sha": "[a-f0-9]*"' | head -1 | sed 's/.*"\([a-f0-9]*\)".*/\1/'
}

try_channel() {  # $1 = 代理地址（空串 = 直连）
  local proxy="$1" label PROXY
  if [ -z "$proxy" ]; then
    label="直连"; PROXY=(-c http.proxy= -c https.proxy=)
  else
    label="代理 $proxy"; PROXY=(-c "http.proxy=$proxy" -c "https.proxy=$proxy")
  fi

  echo ""
  echo "== 试 $label =="

  # lowSpeedLimit/Time + timeout：直连抖动时「push 卡死 10 分钟」比失败更烦人
  timeout 120 env GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git \
    "${PROXY[@]}" "${CRED[@]}" \
    -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 \
    push -u origin main 2>&1 | tail -6

  # GitHub API 读 refs 有秒级延迟：push 刚成功时立刻查可能拿到的还是旧 sha → 误判成失败，
  # 然后白白多试一条通道（实测踩过：直连已推成功，却被判失败又走了代理）。所以要重试几次再下结论。
  local i got=""
  for i in 1 2 3; do
    got=$(remote_sha)
    [ "$got" = "$LOCAL_SHA" ] && break
    sleep 2
  done
  echo "   远端 main = ${got:-<取不到>}"
  if [ "$got" = "$LOCAL_SHA" ]; then
    echo "推送成功（$label）"
    return 0
  fi
  echo "   该通道没推上去，换下一条"
  return 1
}

push_once() {
  local cand
  for cand in "" "http://127.0.0.1:1212" "http://127.0.0.1:7897"; do
    try_channel "$cand" && return 0
  done
  return 1
}

if push_once; then exit 0; fi

if [ "$WAIT" = "1" ]; then
  echo ""
  echo "三条通道都没成功，进入等待模式（最多 30 分钟）…"
  for i in $(seq 1 60); do
    echo "[$(date +%H:%M:%S)] 第 $i/60 次重试"
    if push_once; then exit 0; fi
    sleep 30
  done
  echo "等了 30 分钟还是不行，先停。稍后手动重跑本脚本。"
  exit 2
fi

echo ""
echo "三条通道都没成功。选一个："
echo "   a) 等几分钟再跑本脚本（直连时段性中断，通常约 30 分钟恢复）"
echo "   b) 跑 bash scripts/push-main.sh --wait（自动轮询等网络恢复）"
echo "   c) 开 Clash 后重跑本脚本（会自动用 7897）"
exit 2
