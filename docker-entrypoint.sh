#!/bin/sh
# 容器入口：首次启动（data 卷是空的）先写入演示数据，再起服务。
#
# 为什么要在容器里做这件事：
# 表结构由 schema.sql 自动建，但表里一个用户都没有 —— 打开页面会卡在登录页，
# 而「8 个演示账号一键填充」正是这个项目演示时的第一个动作。
# 让人先手动 docker exec 进去跑 seed，等于把一次演示变成两道工序。
set -e

DB_FILE="${DB_PATH:-/app/data/app.db}"

if [ ! -f "$DB_FILE" ]; then
  echo "[entrypoint] 没找到数据库（$DB_FILE），写入演示数据…"
  # seed 失败不阻断启动：空库至少能起服务、能看 500 长什么样；
  # 但没有账号就登不进去，所以失败要吼一声，不能静默。
  if node seed.js; then
    echo "[entrypoint] 演示数据已写入（8 个演示账号，密码见 README）"
  else
    echo "[entrypoint] ⚠️ seed 失败：服务会起来，但库里没有账号，登录不了。"
    echo "[entrypoint]    排查：docker compose exec office-oa node seed.js"
  fi
else
  echo "[entrypoint] 复用已有数据库（$DB_FILE）"
fi

exec node index.js
