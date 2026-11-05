#!/usr/bin/env bash
# monitor-backend 一键发布脚本：压缩 → 上传 → 校验 → 备份 → 解压 → 依赖 → 迁移 → 重启 → 检查 → 清理
#
# 在开发机的仓库根目录执行（WSL / Git Bash 均可，需要 ssh、scp、tar、sha256sum）：
#   bash deploy/deploy.sh root@1.2.3.4
#
# 常用环境变量（都可用 NAME=value 前置覆盖）：
#   APP_DIR        远端应用目录，默认 /opt/monitor-backend
#   PM2_APP        PM2 进程名，默认 monitor-backend
#   HEALTH_URL     远端本机健康检查地址，默认 http://127.0.0.1:8888/
#   PUBLIC_URL     发布后附加的公网检查，默认 https://api.wealans.top/；置空跳过
#   BUILD          auto（默认，能构建就构建）/ 1（强制，失败即终止）/ 0（跳过）
#   SKIP_DEPS=1    远端跳过 npm ci
#   SKIP_DB_INIT=1 远端跳过数据库迁移
#   RUN_USER       非空时把远端 dist 属主改为该用户
#   KEEP_PACKAGES  本地保留的历史发布包数量，默认 5
#   DRY_RUN=1      只做本地预检并导出远端脚本，不构建、不传输、不连接
#
# 说明：
#   - 发布包只含 dist/、package.json、package-lock.json；不含 .env、node_modules、mapdata。
#   - 远端失败会自动回滚到上一版 dist 并重启旧版本，不会停留在半成品状态。
#   - 脚本自包含：远端逻辑以 heredoc 形式随 ssh 流式执行，服务器上不落地任何文件。
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
monitor-backend 一键发布（本地执行）

用法:
  bash deploy/deploy.sh [user@]host

示例:
  bash deploy/deploy.sh root@47.100.1.2
  DEPLOY_HOST=root@47.100.1.2 bash deploy/deploy.sh

环境变量:
  APP_DIR  PM2_APP  HEALTH_URL  PUBLIC_URL  BUILD  SKIP_DEPS  SKIP_DB_INIT
  RUN_USER  KEEP_PACKAGES  DRY_RUN
USAGE
}

log()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    [告警] %s\n' "$*" >&2; }
die()  { printf '\n[失败] %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

# ============================== 配置 ==============================

DEPLOY_HOST=${DEPLOY_HOST:-${1:-}}
APP_DIR=${APP_DIR:-/opt/monitor-backend}
PM2_APP=${PM2_APP:-monitor-backend}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8888/}
PUBLIC_URL=${PUBLIC_URL-https://api.wealans.top/}
BUILD=${BUILD:-auto}
SKIP_DEPS=${SKIP_DEPS:-0}
SKIP_DB_INIT=${SKIP_DB_INIT:-0}
RUN_USER=${RUN_USER:-}
KEEP_PACKAGES=${KEEP_PACKAGES:-5}
DRY_RUN=${DRY_RUN:-0}
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}

REMOTE_PKG=/tmp/dist.tar.gz
SSH_CTL=${SSH_CTL:-/tmp/deploy-ssh-%r@%h:%p}
SSH_OPTS=(
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
  -o StrictHostKeyChecking=accept-new
  -o ControlMaster=auto
  -o "ControlPath=$SSH_CTL"
  -o ControlPersist=120
)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LOCAL_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
OUT_DIR=${OUT_DIR:-$LOCAL_DIR/.release}

STAMP=$(date +%Y%m%d-%H%M%S)
PKG_NAME="dist-$STAMP.tar.gz"
PKG="$OUT_DIR/$PKG_NAME"
START_TS=$(date +%s)

if [ -z "$DEPLOY_HOST" ] && [ "$DRY_RUN" != 1 ]; then
  usage
  exit 2
fi

# ============================== 远端逻辑（随 ssh 流式执行） ==============================

remote_preflight() {
  cat <<'PREFLIGHT'
set -Eeuo pipefail
APP_DIR=$1
PM2_APP=$2
[ -d "$APP_DIR" ] || { echo "REMOTE_FAIL 目录不存在: $APP_DIR"; exit 11; }
[ -f "$APP_DIR/.env" ] || { echo "REMOTE_FAIL 缺少 $APP_DIR/.env"; exit 12; }
command -v pm2 >/dev/null 2>&1 || { echo "REMOTE_FAIL 找不到 pm2"; exit 13; }
pm2 describe "$PM2_APP" >/dev/null 2>&1 || { echo "REMOTE_FAIL PM2 中没有进程 $PM2_APP"; exit 14; }
echo "REMOTE_OK"
PREFLIGHT
}

remote_script() {
  cat <<'REMOTE_SCRIPT'
set -Eeuo pipefail

APP_DIR=$1
PM2_APP=$2
HEALTH_URL=$3
PKG=$4
SKIP_DEPS=${5:-0}
SKIP_DB_INIT=${6:-0}
RUN_USER=${7:-}
NPM_REGISTRY=${8:-https://registry.npmmirror.com}
KEEP_BACKUPS=3
HEALTH_RETRIES=20
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=''

log()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    [告警] %s\n' "$*" >&2; }
die()  { printf '\n[失败] %s\n' "$*" >&2; exit 1; }

# 任何一步失败都把新 dist 换回备份并重启，避免磁盘新代码、内存跑旧代码。
rollback() {
  [ -n "$BACKUP" ] && [ -d "$BACKUP" ] || return 0
  rm -rf "$APP_DIR/dist"
  mv "$BACKUP" "$APP_DIR/dist"
  warn "已回滚到 $BACKUP"
  pm2 restart "$PM2_APP" >/dev/null 2>&1 || true
}
trap 'rc=$?; if [ "$rc" -ne 0 ]; then rollback; fi; exit "$rc"' ERR

[ -f "$PKG" ] || die "找不到升级包 $PKG"
CONTENTS=$(tar -tzf "$PKG")
# 用 herestring 而不是管道：grep -q 命中即退出，管道写法在 pipefail 下可能被 SIGPIPE 误判为失败。
grep -qx 'dist/main.js' <<< "$CONTENTS" || die '包结构不对：应包含 dist/main.js'
cd "$APP_DIR" || die "应用目录不存在: $APP_DIR"

fingerprint() {
  if [ -f package-lock.json ]; then sha256sum package-lock.json | cut -d' ' -f1; else echo none; fi
}
LOCK_BEFORE=$(fingerprint)

log '备份当前 dist'
if [ -d dist ]; then
  # 同一秒内连续发布时备份名可能撞车，撞了就加序号，避免 mv 把 dist 嵌进旧备份目录。
  BACKUP="$APP_DIR/dist.bak.$STAMP"
  n=0
  while [ -e "$BACKUP" ]; do
    n=$((n + 1))
    BACKUP="$APP_DIR/dist.bak.$STAMP-$n"
  done
  mv dist "$BACKUP"
  note "旧版本 → $BACKUP"
else
  note '远端没有 dist，按首次部署处理'
fi

log '解压新包'
tar -xzf "$PKG" -C "$APP_DIR"
[ -f dist/main.js ] || die '解压后缺少 dist/main.js'
if [ -n "$RUN_USER" ]; then
  chown -R "$RUN_USER:$RUN_USER" dist
  note "dist 属主 → $RUN_USER"
fi

LOCK_AFTER=$(fingerprint)
if [ "$SKIP_DEPS" = 1 ]; then
  note 'SKIP_DEPS=1，跳过依赖检查'
elif [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  log '依赖清单有变化，重装生产依赖'
  npm ci --omit=dev --registry="$NPM_REGISTRY"
else
  note 'package-lock.json 未变，跳过 npm ci'
fi

if [ "$SKIP_DB_INIT" = 1 ]; then
  note 'SKIP_DB_INIT=1，跳过数据库迁移'
else
  log '执行数据库迁移（已执行过的版本会自动跳过）'
  node dist/db-init.js
fi

log '重启进程'
pm2 restart "$PM2_APP" --update-env >/dev/null
note '已发出重启指令，等待健康检查'

CODE=''
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  CODE=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$HEALTH_URL" || true)
  if [ "$CODE" = 200 ]; then break; fi
  sleep 1
done
if [ "$CODE" != 200 ]; then
  warn "健康检查失败：$HEALTH_URL 返回 '$CODE'"
  warn "排查：pm2 logs $PM2_APP --err --lines 50 --nostream"
  false
fi

log "清理旧备份（保留最近 $KEEP_BACKUPS 份）"
ls -1dt "$APP_DIR"/dist.bak.* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
  rm -rf "$old"
  note "删除 $old"
done || true

printf '\n[远端成功] %s 已发布\n' "$PM2_APP"
note "健康检查: $HEALTH_URL → 200"
if [ -n "$BACKUP" ]; then
  note "本次备份: $BACKUP"
fi
REMOTE_SCRIPT
}

# ============================== [1/8] 预检 ==============================

log '[1/8] 预检（本地工具 / SSH 连接 / 远端环境）'

for c in ssh scp tar sha256sum; do
  have "$c" || die "缺少命令: $c"
done
note 'ssh / scp / tar / sha256sum 就绪'

CR=$(printf '\r')
if grep -q -- "$CR" "$0" 2>/dev/null; then
  warn '脚本含 CRLF 行结束符，部分环境会报 $'"'"'\r'"'"' 错误，建议转成 LF'
fi

mkdir -p "$OUT_DIR"

if [ "$DRY_RUN" = 1 ]; then
  remote_script > "$OUT_DIR/remote-last.sh"
  note "远端脚本已导出: $OUT_DIR/remote-last.sh"
  note "语法校验: bash -n $OUT_DIR/remote-last.sh"
  note '正式执行顺序: 构建 → 打包 → 上传 → 校验 → 备份/解压/依赖/迁移/重启/检查/清理'
  exit 0
fi

PREFLIGHT_ARGS=$(printf '%q ' "$APP_DIR" "$PM2_APP")
if ! remote_preflight | ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "bash -s -- $PREFLIGHT_ARGS"; then
  die "远端预检未通过，已终止（远端文件未做任何改动）"
fi
note "远端就绪: $DEPLOY_HOST:$APP_DIR（进程 $PM2_APP）"

# ============================== [2/8] 构建 ==============================

log '[2/8] 构建'

npm_ok() { have npm && npm --version >/dev/null 2>&1; }

# 优先用当前 shell 的 npm；失败再退回 Windows 的 node.exe（WSL 里常见：npm 在 PATH 但 node 不在）。
build_with_local_npm() {
  ( cd "$LOCAL_DIR" && npm run build )
}

build_with_windows_node() {
  local node_win node_bin npm_cli
  have cmd.exe || return 1
  have wslpath || return 1
  node_win=$(cmd.exe /c where node 2>/dev/null | tr -d '\r' | sed -n '1p' || true)
  [ -n "$node_win" ] || return 1
  node_bin=$(wslpath -u "$node_win")
  [ -x "$node_bin" ] || return 1
  npm_cli="$(dirname "$node_bin")/node_modules/npm/bin/npm-cli.js"
  [ -f "$npm_cli" ] || return 1
  note "改用 Windows Node 构建: $node_bin"
  ( cd "$LOCAL_DIR" && "$node_bin" "$npm_cli" run build )
}

if [ "$BUILD" = 0 ]; then
  note 'BUILD=0，跳过构建，使用现有 dist'
elif npm_ok && build_with_local_npm; then
  note '构建完成（npm run build）'
elif build_with_windows_node; then
  note '构建完成（Windows node 桥接）'
elif [ "$BUILD" = 1 ]; then
  die '构建失败：BUILD=1 要求构建必须成功'
else
  warn '构建失败或不可用，继续使用现有 dist'
fi

[ -f "$LOCAL_DIR/dist/main.js" ] || die '缺少 dist/main.js：请先执行 npm run build，或用 BUILD=1 让脚本构建'

# ============================== [3/8] 打包 ==============================

log '[3/8] 打包'
( cd "$LOCAL_DIR" && tar -czf "$PKG" -C "$LOCAL_DIR" dist package.json package-lock.json )
[ -f "$PKG" ] || die "打包失败: $PKG"
SIZE=$(du -h "$PKG" | cut -f1)
note "$PKG_NAME（$SIZE）"

# ============================== [4/8] 校验 ==============================

log '[4/8] 校验发布包'
CONTENTS=$(tar -tzf "$PKG")
grep -qx 'dist/main.js' <<< "$CONTENTS" || die '包内缺少 dist/main.js（打包层级不对）'
FILE_COUNT=$(grep -c '^dist/' <<< "$CONTENTS" || true)
note "dist 条目数: $FILE_COUNT（含子目录）"

LOCAL_SHA=$(sha256sum "$PKG" | cut -d' ' -f1)
printf '%s  %s\n' "$LOCAL_SHA" "$PKG_NAME" > "$PKG.sha256"
note "sha256: $LOCAL_SHA"

# ============================== [5/8] 上传 ==============================

log '[5/8] 上传'
scp "${SSH_OPTS[@]}" "$PKG" "$DEPLOY_HOST:$REMOTE_PKG" >/dev/null \
  || die "上传失败：scp $PKG → $DEPLOY_HOST:$REMOTE_PKG（远端未做任何改动）"
note "已上传到 $DEPLOY_HOST:$REMOTE_PKG"

# ============================== [6/8] 远端校验 ==============================

log '[6/8] 远端校验'
REMOTE_SHA=$(ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "sha256sum $REMOTE_PKG | cut -d' ' -f1") \
  || die "无法在远端计算校验和（远端未做任何改动）"
[ "$REMOTE_SHA" = "$LOCAL_SHA" ] || die "校验和不一致（本地 $LOCAL_SHA / 远端 $REMOTE_SHA），传输可能损坏，未改动线上"
note '校验和一致'

# ============================== [7/8] 发布 ==============================

log '[7/8] 发布（备份 → 解压 → 依赖 → 迁移 → 重启 → 检查 → 清理）'
REMOTE_ARGS=$(printf '%q ' "$APP_DIR" "$PM2_APP" "$HEALTH_URL" "$REMOTE_PKG" "$SKIP_DEPS" "$SKIP_DB_INIT" "$RUN_USER" "$NPM_REGISTRY")
if ! remote_script | ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "bash -s -- $REMOTE_ARGS"; then
  die '远端发布失败：见上方远端日志（远端已自动回滚到上一版）'
fi

# ============================== [8/8] 汇总 ==============================

log '[8/8] 汇总'
ELAPSED=$(( $(date +%s) - START_TS ))
note "发布包: $PKG_NAME（$SIZE）"
note "总耗时: ${ELAPSED}s"

if [ -n "$PUBLIC_URL" ]; then
  PUBLIC_CODE=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$PUBLIC_URL" || true)
  if [ "$PUBLIC_CODE" = 200 ]; then
    note "公网检查: $PUBLIC_URL → 200"
  else
    warn "公网检查: $PUBLIC_URL → '$PUBLIC_CODE'（后端正常但入口异常时查 nginx）"
  fi
fi

LATEST_BACKUP=$(ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "ls -1dt $APP_DIR/dist.bak.* 2>/dev/null | head -1" || true)
if [ -n "$LATEST_BACKUP" ]; then
  note "远端最近备份: $LATEST_BACKUP"
  note "手动回滚: ssh $DEPLOY_HOST \"rm -rf $APP_DIR/dist && mv $LATEST_BACKUP $APP_DIR/dist && pm2 restart $PM2_APP\""
fi

ssh -O exit -o "ControlPath=$SSH_CTL" "$DEPLOY_HOST" >/dev/null 2>&1 || true

ls -1dt "$OUT_DIR"/dist-*.tar.gz 2>/dev/null | tail -n +$((KEEP_PACKAGES + 1)) | while read -r old; do
  rm -f "$old" "$old.sha256"
  note "清理本地旧包: $(basename "$old")"
done || true

printf '\n[成功] %s 已发布到 %s（用时 %ss）\n' "$PM2_APP" "$DEPLOY_HOST" "$ELAPSED"
