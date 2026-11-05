#!/usr/bin/env bash
# monitor-backend 一键环境初始化：检查环境 → Node 22+ → nginx → Redis → MySQL → 校验 → 输出安装位置。
#
# 目标平台：Ubuntu 22.04/24.04、Debian 12（apt + systemd），需 root 执行。
#
# 用法：
#   bash deploy/init.sh                                    # 交互式询问 MySQL root 密码
#   MYSQL_ROOT_PASSWORD='***' MYSQL_PASSWORD='***' bash deploy/init.sh
#   bash deploy/init.sh --check-only                       # 只检查环境，不安装
#   SKIP_NGINX=1 SKIP_MYSQL=1 bash deploy/init.sh          # 分机部署时跳过组件
#
# 约定：
#   - 配置项集中在下方「配置区」，同名环境变量优先于脚本内默认值。
#   - 重复执行安全：托管配置块先删除再写入，绝不删除 MySQL/Redis 数据目录。
#   - 会创建 root@'%'（MYSQL_ROOT_REMOTE=0 可关闭）与 monitor 账号，并把 MySQL、
#     Redis 监听在 0.0.0.0。请用云安全组限制来源，不要把 3306/6379 直接暴露公网。
set -Eeuo pipefail

# ============================== 配置区 ==============================
# 同名环境变量优先，例如：MYSQL_ROOT_PASSWORD='123456' MYSQL_PASSWORD='123456' bash deploy/init.sh

# ---- Node.js ----
NODE_VERSION=${NODE_VERSION:-}                                        # 留空自动取镜像最新 v22.x
NODE_MIN_MAJOR=${NODE_MIN_MAJOR:-22}                                  # 已装版本大于等于该主版本则跳过
NODE_DIST_MIRROR=${NODE_DIST_MIRROR:-https://cdn.npmmirror.com/binaries/node}
NODE_FALLBACK_VERSION=${NODE_FALLBACK_VERSION:-22.11.0}               # 版本列表获取失败时的兜底版本
NODE_INSTALL_DIR=${NODE_INSTALL_DIR:-/usr/local}                      # tarball 解压目标
NPM_REGISTRY=${NPM_REGISTRY:-}                                        # 非空才修改 npm 全局源
NODE_PURGE_APT=${NODE_PURGE_APT:-0}                                   # 设为 1 时卸载发行版 nodejs

# ---- nginx ----
NGINX_LISTEN_PORT=${NGINX_LISTEN_PORT:-80}                            # 对外入口端口
NGINX_TLS_CERT=${NGINX_TLS_CERT:-}                                    # 与 KEY 同时配置才启用 HTTPS
NGINX_TLS_KEY=${NGINX_TLS_KEY:-}
NGINX_SITE_NAME=${NGINX_SITE_NAME:-monitor-backend}                   # 生成 /etc/nginx/conf.d/<name>.conf
BACKEND_HOST=${BACKEND_HOST:-127.0.0.1}                               # 反代上游地址
BACKEND_PORT=${BACKEND_PORT:-}                                        # 留空读 ../.env 的 PORT，再回退 8888

# ---- Redis ----
REDIS_PORT=${REDIS_PORT:-6379}
REDIS_PASSWORD=${REDIS_PASSWORD:-}                                    # 留空不设密码（同时关闭 protected-mode）
REDIS_MAXMEMORY=${REDIS_MAXMEMORY:-256mb}                             # 与 docs/ingestion.md 示例一致

# ---- MySQL ----
MYSQL_PORT=${MYSQL_PORT:-3306}
MYSQL_USER=${MYSQL_USER:-monitor}                                     # 应用账号
MYSQL_PASSWORD=${MYSQL_PASSWORD:-}                                    # 留空复用 MYSQL_ROOT_PASSWORD
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD:-}                          # 留空：交互询问，非交互随机生成
MYSQL_DATABASE=${MYSQL_DATABASE:-weils_monitor}
MYSQL_ROOT_REMOTE=${MYSQL_ROOT_REMOTE:-1}                             # 设为 0 只保留 root@'localhost'

# ---- 组件开关（1 = 跳过）----
SKIP_NODE=${SKIP_NODE:-0}
SKIP_NGINX=${SKIP_NGINX:-0}
SKIP_REDIS=${SKIP_REDIS:-0}
SKIP_MYSQL=${SKIP_MYSQL:-0}
# ===================================================================

TIME_STAMP=$(date +%Y%m%d-%H%M%S)
MARK_BEGIN='# >>> monitor-backend init.sh >>>'
MARK_END='# <<< monitor-backend init.sh <<<'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=$REPO_ROOT/.env

NGINX_SITE_FILE=/etc/nginx/conf.d/${NGINX_SITE_NAME}.conf
MYSQL_CONF=/etc/mysql/mysql.conf.d/mysqld.cnf
REDIS_CONF=/etc/redis/redis.conf

CHECK_ONLY=0
MEM_KB=0
SMALL_MEM=0
ROOT_CNF=''
NODE_ARCH=''
MYSQL_VERSION=''
MYSQL_AUTH_PLUGIN='caching_sha2_password'
GENERATED_MYSQL_ROOT=0
TMP_FILES=()
TMP_DIRS=()

# ============================== 通用函数 ==============================

usage() {
  cat <<'USAGE'
monitor-backend 环境初始化脚本（Ubuntu/Debian，需 root）

用法:
  bash deploy/init.sh [--check-only]

常用环境变量（也可直接修改脚本「配置区」）:
  MYSQL_ROOT_PASSWORD   MySQL root 密码；留空则交互询问，非交互时随机生成并打印
  MYSQL_PASSWORD        monitor 账号密码；留空复用 root 密码
  MYSQL_ROOT_REMOTE     1（默认）同时创建 root@'%'；0 只保留 root@'localhost'
  NGINX_LISTEN_PORT     nginx 入口端口，默认 80
  BACKEND_PORT          反代后端端口；留空读 ../.env 的 PORT，再回退 8888
  REDIS_PORT            Redis 端口，默认 6379
  REDIS_PASSWORD        Redis 密码；留空不设密码
  NODE_VERSION          指定 Node 版本，如 22.22.3；留空自动选最新 v22.x
  SKIP_NODE / SKIP_NGINX / SKIP_REDIS / SKIP_MYSQL   设为 1 跳过对应组件

幂等说明:
  重复执行安全。Redis/MySQL 的托管配置块会先删除再写入；被修改的配置先备份到
  /var/backups/monitor-init/，不会留在会被服务再次加载的目录里，也不会删除
  /var/lib/mysql、/var/lib/redis 等数据目录。
USAGE
}

log()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    [告警] %s\n' "$*" >&2; }
die()  { printf '\n[失败] %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

on_error() {
  printf '\n[失败] 第 %s 行执行出错，已中止。\n' "$1" >&2
  printf '        修正后可直接重跑：脚本幂等，不会重复写入托管配置。\n' >&2
}

cleanup() {
  local f
  if [ "${#TMP_FILES[@]}" -gt 0 ]; then
    for f in "${TMP_FILES[@]}"; do rm -f -- "$f" || true; done
  fi
  if [ "${#TMP_DIRS[@]}" -gt 0 ]; then
    for f in "${TMP_DIRS[@]}"; do rm -rf -- "$f" || true; done
  fi
}
trap cleanup EXIT
trap 'on_error $LINENO' ERR

# 读取 .env 中某个键的值，去掉首尾引号与 CR，找不到时输出空串。
env_value() {
  local key=$1
  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi
  sed -nE "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 | tr -d '\r"'
}

ensure_trailing_newline() {
  local file=$1
  if [ ! -f "$file" ]; then
    return 0
  fi
  if [ -n "$(tail -c 1 -- "$file" 2>/dev/null || true)" ]; then
    printf '\n' >> "$file"
  fi
}

# 备份到 /var/backups/monitor-init/，绝不留在会被服务再次加载的目录里
# （nginx 的 sites-enabled/* 与 MySQL 的 conf.d 都按目录整体加载）。
backup_file() {
  local file=$1
  local dir=/var/backups/monitor-init
  local dest
  if [ -f "$file" ]; then
    mkdir -p "$dir"
    dest="${dir}/$(basename -- "$file").${TIME_STAMP}"
    cp -a -- "$file" "$dest"
    note "已备份 $file → $dest"
  fi
}

# 删除本脚本此前写入的托管块（按起止标记整段删除）。
strip_block() {
  local file=$1
  if [ ! -f "$file" ]; then
    return 0
  fi
  sed -i "/^${MARK_BEGIN}$/,/^${MARK_END}$/d" "$file"
}

# 以固定间隔重试命令，全部失败时返回 1。
retry() {
  local attempts=$1
  local delay=$2
  local i=0
  shift 2
  until "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge "$attempts" ]; then
      return 1
    fi
    sleep "$delay"
  done
  return 0
}

check_port() {
  local name=$1
  local value=$2
  case "$value" in
    ''|*[!0-9]*) die "${name} 必须是 1–65535 的整数，当前值: ${value}" ;;
  esac
  if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    die "${name} 必须是 1–65535 的整数，当前值: ${value}"
  fi
}

# 密码限制在不会破坏 SQL/配置引号的字符集内，避免转义漏洞。
check_password() {
  local name=$1
  local value=$2
  if [ -z "$value" ]; then
    return 0
  fi
  local len=${#value}
  if [ "$len" -lt 6 ] || [ "$len" -gt 128 ]; then
    die "${name} 长度需在 6–128 之间，当前 ${len} 位"
  fi
  case "$value" in
    *\'*|*\"*|*\\*) die "${name} 不能包含单引号、双引号或反斜杠" ;;
    *[![:print:]]*) die "${name} 不能包含空白或控制字符" ;;
  esac
}

version_ge() {
  local a=$1
  local b=$2
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n 1)" = "$b" ]
}

port_in_use() {
  local port=$1
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"
}

port_process() {
  local port=$1
  ss -ltnpH 2>/dev/null | awk -v p="[:.]${port}\$" '$4 ~ p {print; exit}'
}

apt_update() {
  DEBIAN_FRONTEND=noninteractive apt-get update -q
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold "$@"
}

# ============================== [1/7] 环境检查 ==============================

check_os_and_privileges() {
  if [ "$(id -u)" -ne 0 ]; then
    die '请用 root 执行：sudo bash deploy/init.sh'
  fi
  if [ ! -f /etc/os-release ]; then
    die '找不到 /etc/os-release，无法识别系统'
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) note "系统: ${PRETTY_NAME:-$ID}" ;;
    *) die "仅支持 Ubuntu/Debian（apt + systemd），当前: ${PRETTY_NAME:-$ID}。
       CentOS 7 的 glibc 2.17 无法运行 Node 22 官方二进制，请先更换系统。" ;;
  esac
  if [ ! -d /run/systemd/system ]; then
    die '未检测到 systemd，本脚本依赖 systemctl'
  fi
  local cmd
  for cmd in systemctl apt-get curl openssl; do
    have "$cmd" || die "缺少命令: $cmd"
  done
}

check_resources() {
  local avail_kb
  avail_kb=$(df -Pk / | awk 'NR==2 {print $4}')
  avail_kb=${avail_kb:-0}
  if [ "$avail_kb" -lt $((5 * 1024 * 1024)) ]; then
    die "根分区可用空间不足 5G（当前约 $((avail_kb / 1024)) M）"
  fi
  note "根分区可用空间: $((avail_kb / 1024 / 1024)) G"

  MEM_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  MEM_KB=${MEM_KB:-0}
  if [ "$MEM_KB" -lt $((2 * 1024 * 1024)) ]; then
    SMALL_MEM=1
    warn "内存 $(awk -v k="$MEM_KB" 'BEGIN { printf "%.1f", k / 1024 / 1024 }') GiB：按小内存档位调优（MySQL buffer pool 256M、关闭 performance_schema），建议同时准备 swap"
  else
    SMALL_MEM=0
  fi
}

check_arch() {
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) die "不支持的 CPU 架构: $(uname -m)" ;;
  esac
  note "架构: $(uname -m) → Node tarball linux-${NODE_ARCH}"
}

resolve_backend_port() {
  if [ -z "$BACKEND_PORT" ] && [ -f "$ENV_FILE" ]; then
    BACKEND_PORT=$(env_value PORT)
    if [ -n "$BACKEND_PORT" ]; then
      note "从 $ENV_FILE 读取 PORT=$BACKEND_PORT"
    fi
  fi
  BACKEND_PORT=${BACKEND_PORT:-8888}
}

check_config_values() {
  check_port NGINX_LISTEN_PORT "$NGINX_LISTEN_PORT"
  check_port BACKEND_PORT "$BACKEND_PORT"
  check_port REDIS_PORT "$REDIS_PORT"
  check_port MYSQL_PORT "$MYSQL_PORT"

  if [ "$NGINX_LISTEN_PORT" = "$BACKEND_PORT" ]; then
    die "入口端口与后端端口相同（$BACKEND_PORT）：请修改 NGINX_LISTEN_PORT（推荐 80）或 .env 的 PORT"
  fi
  if [ "$REDIS_PORT" = "$NGINX_LISTEN_PORT" ] || [ "$REDIS_PORT" = "$BACKEND_PORT" ] ||
     [ "$MYSQL_PORT" = "$NGINX_LISTEN_PORT" ] || [ "$MYSQL_PORT" = "$BACKEND_PORT" ] ||
     [ "$MYSQL_PORT" = "$REDIS_PORT" ]; then
    die "端口冲突：NGINX_LISTEN_PORT=$NGINX_LISTEN_PORT BACKEND_PORT=$BACKEND_PORT REDIS_PORT=$REDIS_PORT MYSQL_PORT=$MYSQL_PORT"
  fi
  case "$SMALL_MEM" in
    0|1) ;;
    *) die 'SMALL_MEM 只能是 0 或 1' ;;
  esac
}

check_port_usage() {
  local info
  if port_in_use "$NGINX_LISTEN_PORT"; then
    info=$(port_process "$NGINX_LISTEN_PORT")
    case "$info" in
      *nginx*) note "端口 $NGINX_LISTEN_PORT 已被 nginx 占用（重复执行时属正常）" ;;
      *) warn "端口 $NGINX_LISTEN_PORT 被占用: ${info:-未知进程}" ;;
    esac
  fi
  if port_in_use "$BACKEND_PORT"; then
    info=$(port_process "$BACKEND_PORT")
    case "$info" in
      *node*) note "端口 $BACKEND_PORT 已被 node 占用（后端可能已在运行）" ;;
      *) warn "端口 $BACKEND_PORT 被其他进程占用: ${info:-未知进程}" ;;
    esac
  fi
  if port_in_use "$REDIS_PORT"; then
    info=$(port_process "$REDIS_PORT")
    case "$info" in
      *redis*) note "端口 $REDIS_PORT 已被 redis-server 占用（将按配置重载）" ;;
      *) die "端口 $REDIS_PORT 被其他进程占用: ${info:-未知进程}" ;;
    esac
  fi
  if port_in_use "$MYSQL_PORT"; then
    info=$(port_process "$MYSQL_PORT")
    case "$info" in
      *mysqld*) note "端口 $MYSQL_PORT 已被 mysqld 占用（将按配置重载）" ;;
      *) die "端口 $MYSQL_PORT 被其他进程占用: ${info:-未知进程}" ;;
    esac
  fi
}

check_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    warn "未找到 $ENV_FILE：部署后需自行写入 MYSQL_*/REDIS_* 与 PORT"
    return 0
  fi
  note "发现配置文件 $ENV_FILE"
  local port redis_port mysql_port database
  port=$(env_value PORT)
  redis_port=$(env_value REDIS_PORT)
  mysql_port=$(env_value MYSQL_PORT)
  database=$(env_value MYSQL_DATABASE)
  if [ -n "$port" ] && [ "$port" != "$BACKEND_PORT" ]; then
    warn ".env 的 PORT=$port 与本次反代端口 $BACKEND_PORT 不一致，部署后会 502"
  fi
  if [ -n "$redis_port" ] && [ "$redis_port" != "$REDIS_PORT" ]; then
    warn ".env 的 REDIS_PORT=$redis_port 与本次安装的 $REDIS_PORT 不一致"
  fi
  if [ -n "$mysql_port" ] && [ "$mysql_port" != "$MYSQL_PORT" ]; then
    warn ".env 的 MYSQL_PORT=$mysql_port 与本次安装的 $MYSQL_PORT 不一致"
  fi
  if [ -n "$database" ] && [ "$database" != "$MYSQL_DATABASE" ]; then
    warn ".env 的 MYSQL_DATABASE=$database 与本次创建的 $MYSQL_DATABASE 不一致"
  fi
}

check_existing_nginx_site() {
  local frontend_conf=/etc/nginx/conf.d/monitor-frontend.conf
  if [ -f "$frontend_conf" ]; then
    warn "已存在 $frontend_conf（前端工作台入口）：同机部署时请把 NGINX_LISTEN_PORT 改成前端未占用的端口，或 SKIP_NGINX=1 复用前端配置里的 /api/ 反代"
  fi
}

check_node_state() {
  if ! have node; then
    note '未检测到 node，将安装 Node 22+'
    return 0
  fi
  local current
  current=$(node -v 2>/dev/null || true)
  note "当前 node: ${current:-未知}（$(command -v node)）"
  local major
  major=$(printf '%s' "$current" | sed -nE 's/^v([0-9]+).*/\1/p')
  major=${major:-0}
  if [ "$major" -lt "$NODE_MIN_MAJOR" ]; then
    warn "现有 Node 低于 v${NODE_MIN_MAJOR}，将安装到 $NODE_INSTALL_DIR"
  fi
}

# check-only 模式下不生成随机密码，只在安装阶段才决策。
resolve_passwords() {
  if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
    if [ "$CHECK_ONLY" -eq 1 ]; then
      note '未提供 MYSQL_ROOT_PASSWORD（安装阶段会交互询问或随机生成）'
    else
      if [ -t 0 ]; then
        printf '    MySQL root 密码（不回显，直接回车则随机生成）: ' >&2
        read -rs MYSQL_ROOT_PASSWORD || true
        printf '\n' >&2
      fi
      if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
        MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)
        GENERATED_MYSQL_ROOT=1
        warn "已生成随机 root 密码: $MYSQL_ROOT_PASSWORD （请立即记录）"
      fi
    fi
  fi

  if [ -z "$MYSQL_PASSWORD" ] && [ -n "$MYSQL_ROOT_PASSWORD" ]; then
    MYSQL_PASSWORD=$MYSQL_ROOT_PASSWORD
    note '未提供 MYSQL_PASSWORD，monitor 账号复用 root 密码'
  fi
  if [ -z "$MYSQL_USER" ]; then
    die 'MYSQL_USER 不能为空'
  fi
  case "$MYSQL_USER" in
    *[!A-Za-z0-9_.-]*) die "MYSQL_USER 只能包含字母、数字、下划线、点或短横线: $MYSQL_USER" ;;
  esac
  case "$MYSQL_DATABASE" in
    *[!A-Za-z0-9_]*) die "MYSQL_DATABASE 只能包含字母、数字和下划线: $MYSQL_DATABASE" ;;
  esac

  check_password MYSQL_ROOT_PASSWORD "${MYSQL_ROOT_PASSWORD:-}"
  check_password MYSQL_PASSWORD "${MYSQL_PASSWORD:-}"
  check_password REDIS_PASSWORD "${REDIS_PASSWORD:-}"

  if [ -n "$MYSQL_ROOT_PASSWORD" ] && [ "${#MYSQL_ROOT_PASSWORD}" -lt 8 ]; then
    warn 'MySQL 密码短于 8 位，属弱口令：请确保 3306 只对可信网段开放（云安全组）'
  fi
}

step_env_check() {
  log '[1/7] 检查环境'
  check_os_and_privileges
  check_resources
  check_arch
  resolve_backend_port
  resolve_passwords
  check_config_values
  check_env_file
  check_port_usage
  check_existing_nginx_site
  check_node_state
  if [ "$CHECK_ONLY" -eq 0 ]; then
    if apt_update; then
      note 'apt 软件源可用'
    else
      die 'apt-get update 失败：请检查网络或更换国内镜像源后重试'
    fi
  else
    if apt_update; then
      note 'apt 软件源可用'
    else
      warn 'apt-get update 失败，安装阶段会中止'
    fi
  fi
}

# ============================== [2/7] Node.js 22+ ==============================

node_major_version() {
  local current
  current=$(node -v 2>/dev/null || true)
  local major
  major=$(printf '%s' "$current" | sed -nE 's/^v([0-9]+).*/\1/p')
  printf '%s' "${major:-0}"
}

resolve_node_version() {
  local base list picked
  for base in "$NODE_DIST_MIRROR" "https://nodejs.org/dist"; do
    list=$(curl -fsSL --max-time 20 "${base%/}/index.json" 2>/dev/null || true)
    if [ -z "$list" ]; then
      continue
    fi
    picked=$(printf '%s' "$list" | tr ',' '\n')
    picked=$(printf '%s\n' "$picked" | sed -nE 's/.*"version":"v([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p')
    picked=$(printf '%s\n' "$picked" | awk -F. -v m="$NODE_MIN_MAJOR" '$1 == m' | sort -V | tail -n 1)
    if [ -n "$picked" ]; then
      printf '%s' "$picked"
      return 0
    fi
  done
  warn "无法从镜像获取 v${NODE_MIN_MAJOR}.x 版本列表，回退 $NODE_FALLBACK_VERSION"
  printf '%s' "$NODE_FALLBACK_VERSION"
}

install_node() {
  log "[2/7] Node.js ${NODE_MIN_MAJOR}+"
  if [ "$SKIP_NODE" -eq 1 ]; then
    note 'SKIP_NODE=1，跳过'
    return 0
  fi
  if have node && [ "$(node_major_version)" -ge "$NODE_MIN_MAJOR" ]; then
    note "已安装 $(node -v)（$(command -v node)），跳过安装"
  else
    apt_install curl ca-certificates xz-utils

    local ver
    ver=${NODE_VERSION:-$(resolve_node_version)}
    ver=${ver#v}
    [ -n "$ver" ] || die '未能确定要安装的 Node 版本'

    local file="node-v${ver}-linux-${NODE_ARCH}.tar.xz"
    local work
    work=$(mktemp -d /tmp/monitor-init-node.XXXXXX)
    TMP_DIRS+=("$work")

    local base src=''
    for base in "$NODE_DIST_MIRROR" "https://nodejs.org/dist"; do
      note "下载 ${file} ← ${base%/}"
      if curl -fL --retry 3 --retry-delay 2 -C - --max-time 900 \
        -o "${work}/${file}" "${base%/}/v${ver}/${file}"; then
        if curl -fsSL --max-time 60 -o "${work}/SHASUMS256.txt" "${base%/}/v${ver}/SHASUMS256.txt"; then
          src=$base
          break
        fi
      fi
      warn "从 ${base%/} 获取失败，尝试下一个源"
    done
    if [ -z "$src" ]; then
      die "Node ${ver} 下载失败。可手动下载 ${file} 与 SHASUMS256.txt 后重试，或指定 NODE_DIST_MIRROR"
    fi

    if ! ( cd "$work" && grep -E "  ${file}\$" SHASUMS256.txt | sha256sum -c - ); then
      rm -f -- "${work}/${file}"
      die 'Node 安装包 sha256 校验失败，产物不完整，已删除，请重试'
    fi

    if [ "$NODE_PURGE_APT" -eq 1 ] && dpkg -s nodejs >/dev/null 2>&1; then
      apt-get remove -y nodejs npm >/dev/null 2>&1 || true
      note '已卸载发行版 nodejs/npm（NODE_PURGE_APT=1）'
    fi

    mkdir -p "$NODE_INSTALL_DIR"
    tar -xJf "${work}/${file}" -C "$NODE_INSTALL_DIR" --strip-components=1
    hash -r || true

    local resolved
    resolved=$(command -v node || true)
    if [ -z "$resolved" ]; then
      die "安装后仍找不到 node，请确认 ${NODE_INSTALL_DIR}/bin 在 PATH 中"
    fi
    case "$resolved" in
      "${NODE_INSTALL_DIR}"/*) note "node 已就位: $resolved" ;;
      *) warn "PATH 中优先命中的是 $resolved，如要使用新版本请调整 PATH，或设 NODE_PURGE_APT=1 卸载发行版 nodejs" ;;
    esac
    if [ "$(node_major_version)" -lt "$NODE_MIN_MAJOR" ]; then
      die "安装后 node 版本仍低于 v${NODE_MIN_MAJOR}（当前 $(node -v)）"
    fi
    note "已安装 Node $(node -v)"
  fi

  if ! have npm; then
    die '找不到 npm：Node 安装不完整，请重新执行'
  fi
  note "npm $(npm -v)"
  if [ -n "$NPM_REGISTRY" ]; then
    npm config set registry "$NPM_REGISTRY"
    note "npm registry = $(npm config get registry)"
  fi
}

# ============================== [3/7] nginx ==============================

write_nginx_site() {
  local listen_line=''
  local extra_ssl=''

  if [ -n "$NGINX_TLS_CERT" ] || [ -n "$NGINX_TLS_KEY" ]; then
    if [ -z "$NGINX_TLS_CERT" ] || [ -z "$NGINX_TLS_KEY" ]; then
      die 'NGINX_TLS_CERT 与 NGINX_TLS_KEY 必须同时配置'
    fi
    [ -f "$NGINX_TLS_CERT" ] || die "证书文件不存在: $NGINX_TLS_CERT"
    [ -f "$NGINX_TLS_KEY" ] || die "私钥文件不存在: $NGINX_TLS_KEY"
    listen_line="listen ${NGINX_LISTEN_PORT} ssl http2;"
    extra_ssl="    ssl_certificate ${NGINX_TLS_CERT};
    ssl_certificate_key ${NGINX_TLS_KEY};
    ssl_protocols TLSv1.2 TLSv1.3;"
  else
    listen_line="listen ${NGINX_LISTEN_PORT};"
  fi

  cat > "$NGINX_SITE_FILE" <<NGINX_CONF
# 由 monitor-backend/deploy/init.sh 生成，重复执行会覆盖本文件。
# 入口端口 ${NGINX_LISTEN_PORT}，反代 http://${BACKEND_HOST}:${BACKEND_PORT}。
server {
    ${listen_line}
    server_name _;
${extra_ssl}

    # Source Map 单文件上限默认 30MB，代理层留出余量。
    client_max_body_size 32m;
    client_body_timeout 60s;
    access_log /var/log/nginx/monitor-backend-access.log;
    error_log /var/log/nginx/monitor-backend-error.log;

    add_header X-Content-Type-Options nosniff always;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
    add_header Access-Control-Allow-Headers \$http_access_control_request_headers always;
    add_header Access-Control-Max-Age 86400 always;

    # 预检请求直接返回空响应，不进入 Nest。
    if (\$request_method = OPTIONS) {
        return 204;
    }

    # 私有映射目录与 .map 一律不允许通过代理下载。
    location = /mapdata { return 404; }
    location ^~ /mapdata/ { return 404; }
    location ~* \.map\$ { return 404; }

    location / {
        proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
NGINX_CONF
  note "已写入站点配置 $NGINX_SITE_FILE"
}

disable_default_site_if_conflicting() {
  local file=/etc/nginx/sites-enabled/default
  local dir=/var/backups/monitor-init
  local dest
  if [ ! -e "$file" ]; then
    return 0
  fi
  if grep -qE "^[[:space:]]*listen[[:space:]]+([0-9.]+:)?${NGINX_LISTEN_PORT}([[:space:]]|;)" "$file"; then
    mkdir -p "$dir"
    dest="${dir}/default.sites-enabled.${TIME_STAMP}"
    mv "$file" "$dest"
    warn "已停用 Ubuntu 默认站点（占用端口 $NGINX_LISTEN_PORT），原文件移到 $dest"
  fi
}

check_nginx_conflicts() {
  local pattern
  local conflicts
  pattern="^[[:space:]]*listen[[:space:]]+([0-9.]+:)?${NGINX_LISTEN_PORT}([[:space:]]|;)"
  conflicts=$(grep -rlE "$pattern" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -v -F -- "$NGINX_SITE_FILE" || true)
  if [ -n "$conflicts" ]; then
    die "以下 nginx 配置也监听了端口 ${NGINX_LISTEN_PORT}，请先处理：
${conflicts}
       同机已有 monitor-frontend.conf 时：把 NGINX_LISTEN_PORT 改成其他端口，
       或设 SKIP_NGINX=1 复用前端配置中的 /api/ 反代。"
  fi
}

setup_nginx() {
  log '[3/7] nginx'
  if [ "$SKIP_NGINX" -eq 1 ]; then
    note 'SKIP_NGINX=1，跳过'
    return 0
  fi
  apt_install nginx
  systemctl enable nginx >/dev/null 2>&1 || warn 'systemctl enable nginx 失败，重启后可能不会自启'

  backup_file "$NGINX_SITE_FILE"
  strip_block "$NGINX_SITE_FILE"
  write_nginx_site
  disable_default_site_if_conflicting
  check_nginx_conflicts

  if ! nginx -t; then
    die "nginx 配置校验失败，请检查 $NGINX_SITE_FILE"
  fi
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  else
    systemctl restart nginx
  fi
  systemctl is-active --quiet nginx || die 'nginx 未成功启动，查看 journalctl -u nginx'
  note "nginx 已监听 $NGINX_LISTEN_PORT，反代 http://${BACKEND_HOST}:${BACKEND_PORT}"
}

# ============================== [4/7] Redis ==============================

redis_cli() {
  if [ -n "$REDIS_PASSWORD" ]; then
    REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h 127.0.0.1 -p "$REDIS_PORT" "$@"
  else
    redis-cli -h 127.0.0.1 -p "$REDIS_PORT" "$@"
  fi
}

redis_ready() {
  [ "$(redis_cli ping 2>/dev/null)" = 'PONG' ]
}

append_redis_block() {
  ensure_trailing_newline "$REDIS_CONF"
  {
    printf '%s\n' "$MARK_BEGIN"
    printf 'port %s\n' "$REDIS_PORT"
    printf 'bind 0.0.0.0\n'
    if [ -n "$REDIS_PASSWORD" ]; then
      printf 'protected-mode yes\n'
      printf 'requirepass "%s"\n' "$REDIS_PASSWORD"
    else
      printf 'protected-mode no\n'
    fi
    printf 'maxmemory %s\n' "$REDIS_MAXMEMORY"
    printf 'maxmemory-policy noeviction\n'
    printf 'appendonly yes\n'
    printf 'appendfsync everysec\n'
    printf 'dir /var/lib/redis\n'
    printf '%s\n' "$MARK_END"
  } >> "$REDIS_CONF"
}

setup_redis() {
  log '[4/7] Redis'
  if [ "$SKIP_REDIS" -eq 1 ]; then
    note 'SKIP_REDIS=1，跳过'
    return 0
  fi
  apt_install redis-server

  local version
  version=$(redis-server -v 2>/dev/null | sed -nE 's/.*v=([0-9]+)\..*/\1/p')
  version=${version:-0}
  if [ "$version" -lt 5 ]; then
    die "Redis 主版本需 ≥5（项目要求），当前: $(redis-server -v 2>/dev/null)"
  fi
  note "$(redis-server -v 2>/dev/null)"

  backup_file "$REDIS_CONF"
  strip_block "$REDIS_CONF"
  append_redis_block
  note "已写入托管配置块到 $REDIS_CONF"

  systemctl enable redis-server >/dev/null 2>&1 || warn 'systemctl enable redis-server 失败'
  systemctl restart redis-server
  if ! retry 30 1 redis_ready; then
    die 'Redis 启动后无法 PING 通，查看 journalctl -u redis-server 与 /var/log/redis/redis-server.log'
  fi

  local policy
  policy=$(redis_cli config get maxmemory-policy 2>/dev/null | tail -n 1)
  if [ "$policy" != 'noeviction' ]; then
    die "Redis maxmemory-policy 必须是 noeviction（后端启动的硬性校验），当前: ${policy:-空}"
  fi
  if [ "$(redis_cli -n 5 ping 2>/dev/null)" != 'PONG' ]; then
    die 'Redis DB 5 不可用（项目默认 REDIS_DB=5）'
  fi
  note "maxmemory-policy=noeviction，DB 5 可用，端口 $REDIS_PORT"
}

# ============================== [5/7] MySQL ==============================

write_client_cnf() {
  local file=$1
  local user=$2
  local pass=$3
  {
    printf '[client]\n'
    printf 'user=%s\n' "$user"
    printf 'password=%s\n' "$pass"
  } > "$file"
  chmod 600 "$file"
}

append_mysql_block() {
  local buffer='256M'
  local connections=60
  local ps_line=''
  local redo_line=''

  if [ "$MEM_KB" -ge $((8 * 1024 * 1024)) ]; then
    buffer=$(awk -v k="$MEM_KB" 'BEGIN { v = int(k / 1024 / 1024 * 0.25); if (v > 4096) v = 4096; printf "%dM", v }')
    connections=150
  elif [ "$MEM_KB" -ge $((2 * 1024 * 1024)) ]; then
    buffer='1G'
    connections=150
  else
    ps_line='performance_schema = OFF'
  fi
  if version_ge "${MYSQL_VERSION:-0.0.0}" '8.0.30'; then
    redo_line='innodb_redo_log_capacity = 64M'
  fi

  ensure_trailing_newline "$MYSQL_CONF"
  {
    printf '%s\n' "$MARK_BEGIN"
    printf '[mysqld]\n'
    printf 'bind-address = 0.0.0.0\n'
    printf 'port = %s\n' "$MYSQL_PORT"
    printf 'character-set-server = utf8mb4\n'
    printf 'collation-server = utf8mb4_0900_ai_ci\n'
    printf "default-time-zone = '+00:00'\n"
    printf 'innodb_buffer_pool_size = %s\n' "$buffer"
    if [ -n "$redo_line" ]; then
      printf '%s\n' "$redo_line"
    fi
    printf 'max_connections = %s\n' "$connections"
    printf 'innodb_flush_log_at_trx_commit = 1\n'
    printf 'skip-log-bin\n'
    printf 'mysqlx = OFF\n'
    if [ -n "$ps_line" ]; then
      printf '%s\n' "$ps_line"
    fi
    printf '%s\n' "$MARK_END"
  } >> "$MYSQL_CONF"
  note "已写入托管配置块到 $MYSQL_CONF（buffer pool $buffer，max_connections $connections）"
}

mysql_ready() {
  if mysqladmin ping --silent >/dev/null 2>&1; then
    return 0
  fi
  if [ -n "$ROOT_CNF" ] && [ -f "$ROOT_CNF" ]; then
    mysql --defaults-extra-file="$ROOT_CNF" -N -e 'SELECT 1' >/dev/null 2>&1
    return $?
  fi
  return 1
}

# 探测实例是否仍启用 mysql_native_password（8.4 起默认移除），据此选择建号插件。
# 有密码可用时走默认文件，否则退回本地 socket；两者都失败则留给 ensure_root_access 报错。
detect_auth_plugin() {
  local state=''
  if [ -n "$ROOT_CNF" ] && [ -f "$ROOT_CNF" ]; then
    state=$(mysql --defaults-extra-file="$ROOT_CNF" -N -s -e "SELECT PLUGIN_STATUS FROM information_schema.PLUGINS WHERE PLUGIN_NAME='mysql_native_password'" 2>/dev/null || true)
  fi
  if [ -z "$state" ]; then
    state=$(mysql -N -s -e "SELECT PLUGIN_STATUS FROM information_schema.PLUGINS WHERE PLUGIN_NAME='mysql_native_password'" 2>/dev/null || true)
  fi
  if [ "$state" = 'ACTIVE' ]; then
    MYSQL_AUTH_PLUGIN='mysql_native_password'
    note '账号认证插件: mysql_native_password（兼容 mysql2 明文 TCP）'
  else
    MYSQL_AUTH_PLUGIN='caching_sha2_password'
    warn "mysql_native_password 状态为「${state:-未知}」，改用 caching_sha2_password：客户端需 TLS 或公钥交换"
  fi
}

ensure_root_access() {
  if [ -z "$ROOT_CNF" ]; then
    ROOT_CNF=$(mktemp /tmp/monitor-init-root.XXXXXX)
    TMP_FILES+=("$ROOT_CNF")
    write_client_cnf "$ROOT_CNF" root "$MYSQL_ROOT_PASSWORD"
  fi

  if mysql --defaults-extra-file="$ROOT_CNF" -N -e 'SELECT 1' >/dev/null 2>&1; then
    note 'root 密码登录校验通过'
  elif mysql -N -e 'SELECT 1' >/dev/null 2>&1; then
    note '未配置 root 密码（本地 socket 认证），正在设置密码'
    mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH ${MYSQL_AUTH_PLUGIN} BY '${MYSQL_ROOT_PASSWORD}';"
    if ! mysql --defaults-extra-file="$ROOT_CNF" -N -e 'SELECT 1' >/dev/null 2>&1; then
      die '设置 root 密码后仍无法用密码登录，请检查 MYSQL_ROOT_PASSWORD'
    fi
    warn 'root@localhost 已从 socket 认证改为密码认证：之后手动登录请用 mysql -uroot -p'
  else
    die "无法用 MYSQL_ROOT_PASSWORD 登录 root，且本地 socket 认证也不可用。
       请确认密码与实例一致（已装过 MySQL 的机器尤其注意），或先手动修复 root 认证。"
  fi

  # root@localhost 若仍是 auth_socket，socket 登录会忽略密码（造成“密码可用”的假象），
  # 而 127.0.0.1 的 TCP 连接会反解为 localhost 并被这条记录优先匹配，
  # 导致 root@'%' 永远匹配不到、密码登录报 1698/1045。这里统一改成密码认证。
  local plugin
  plugin=$(mysql --defaults-extra-file="$ROOT_CNF" -N -s -e "SELECT plugin FROM mysql.user WHERE user='root' AND host='localhost'" 2>/dev/null || true)
  if [ -n "$plugin" ]; then
    case "$plugin" in
      auth_socket|unix_socket)
        mysql --defaults-extra-file="$ROOT_CNF" -e \
          "ALTER USER 'root'@'localhost' IDENTIFIED WITH ${MYSQL_AUTH_PLUGIN} BY '${MYSQL_ROOT_PASSWORD}';"
        note "root@localhost 认证插件由 ${plugin} 改为 ${MYSQL_AUTH_PLUGIN}（TCP 才能用密码登录）"
        ;;
    esac
  fi
}

provision_accounts() {
  local sql
  sql=$(mktemp /tmp/monitor-init-accounts.XXXXXX)
  {
    printf "CREATE DATABASE IF NOT EXISTS \`%s\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;\n" "$MYSQL_DATABASE"
    if [ "$MYSQL_ROOT_REMOTE" -eq 1 ]; then
      printf "CREATE USER IF NOT EXISTS 'root'@'%%' IDENTIFIED WITH %s BY '%s';\n" "$MYSQL_AUTH_PLUGIN" "$MYSQL_ROOT_PASSWORD"
      printf "ALTER USER 'root'@'%%' IDENTIFIED WITH %s BY '%s';\n" "$MYSQL_AUTH_PLUGIN" "$MYSQL_ROOT_PASSWORD"
      printf "GRANT ALL PRIVILEGES ON *.* TO 'root'@'%%' WITH GRANT OPTION;\n"
    fi
    printf "CREATE USER IF NOT EXISTS '%s'@'%%' IDENTIFIED WITH %s BY '%s';\n" "$MYSQL_USER" "$MYSQL_AUTH_PLUGIN" "$MYSQL_PASSWORD"
    printf "CREATE USER IF NOT EXISTS '%s'@'localhost' IDENTIFIED WITH %s BY '%s';\n" "$MYSQL_USER" "$MYSQL_AUTH_PLUGIN" "$MYSQL_PASSWORD"
    printf "ALTER USER '%s'@'%%' IDENTIFIED WITH %s BY '%s';\n" "$MYSQL_USER" "$MYSQL_AUTH_PLUGIN" "$MYSQL_PASSWORD"
    printf "ALTER USER '%s'@'localhost' IDENTIFIED WITH %s BY '%s';\n" "$MYSQL_USER" "$MYSQL_AUTH_PLUGIN" "$MYSQL_PASSWORD"
    printf "GRANT ALL PRIVILEGES ON \`%s\`.* TO '%s'@'%%';\n" "$MYSQL_DATABASE" "$MYSQL_USER"
    printf "GRANT ALL PRIVILEGES ON \`%s\`.* TO '%s'@'localhost';\n" "$MYSQL_DATABASE" "$MYSQL_USER"
    printf 'FLUSH PRIVILEGES;\n'
  } > "$sql"
  chmod 600 "$sql"

  if ! mysql --defaults-extra-file="$ROOT_CNF" < "$sql"; then
    die "创建数据库/账号失败（见上方 MySQL 报错）。SQL 已保留在 $sql，可手工执行排查；修正后重跑本脚本即可。"
  fi
  rm -f -- "$sql"
  note "已创建数据库 ${MYSQL_DATABASE} 与账号 ${MYSQL_USER}@'%' / ${MYSQL_USER}@'localhost'"
  if [ "$MYSQL_ROOT_REMOTE" -eq 1 ]; then
    note "已创建 root@'%'（全局权限，等价远程超级用户）"
  fi
}

# 本机 TCP 登录尝试：明文 → 公钥交换 → 强制 TLS，覆盖 mysql_native_password 与
# caching_sha2_password 两种情况，避免因为客户端能力差异误判账号不可用。
mysql_tcp_ok() {
  local cnf=$1
  mysql --defaults-extra-file="$cnf" -h 127.0.0.1 -P "$MYSQL_PORT" -N -e 'SELECT 1' >/dev/null 2>&1 && return 0
  mysql --defaults-extra-file="$cnf" -h 127.0.0.1 -P "$MYSQL_PORT" -N --get-server-public-key -e 'SELECT 1' >/dev/null 2>&1 && return 0
  mysql --defaults-extra-file="$cnf" -h 127.0.0.1 -P "$MYSQL_PORT" -N --ssl-mode=REQUIRED -e 'SELECT 1' >/dev/null 2>&1 && return 0
  return 1
}

verify_mysql_accounts() {
  local cnf
  cnf=$(mktemp /tmp/monitor-init-verify.XXXXXX)
  TMP_FILES+=("$cnf")
  write_client_cnf "$cnf" "$MYSQL_USER" "$MYSQL_PASSWORD"

  local err
  if ! mysql_tcp_ok "$cnf"; then
    err=$(mysql --defaults-extra-file="$cnf" -h 127.0.0.1 -P "$MYSQL_PORT" -N -e 'SELECT 1' 2>&1 || true)
    die "${MYSQL_USER} 账号无法通过 TCP 登录（127.0.0.1:${MYSQL_PORT}）：${err}"
  fi
  if ! mysql_tcp_ok "$ROOT_CNF"; then
    err=$(mysql --defaults-extra-file="$ROOT_CNF" -h 127.0.0.1 -P "$MYSQL_PORT" -N -e 'SELECT 1' 2>&1 || true)
    die "root 无法通过 TCP 登录（127.0.0.1:${MYSQL_PORT}）：${err}
       修复：mysql -e \"ALTER USER 'root'@'localhost' IDENTIFIED WITH ${MYSQL_AUTH_PLUGIN} BY '<密码>';\""
  fi

  # 本机 TCP 会反解成 localhost，被同名的 @'localhost' 账号优先匹配，
  # 所以 @'%' 不能靠本机登录验证，只能查账号是否存在，并打印实际授权供核对。
  # 注意：不能用文本匹配当硬门槛——SHOW GRANTS 的退出码、输出格式都可能变化。
  local remote grants
  if [ "$MYSQL_ROOT_REMOTE" -eq 1 ]; then
    remote=$(mysql --defaults-extra-file="$ROOT_CNF" -N -s -e "SELECT CONCAT(user, '@', host) FROM mysql.user WHERE user='root' AND host='%'" 2>/dev/null || true)
    [ -n "$remote" ] || die "root@'%' 账号未创建成功"
    grants=$(mysql --defaults-extra-file="$ROOT_CNF" -N -s -e "SHOW GRANTS FOR 'root'@'%'" 2>&1 || true)
    case "$grants" in
      *'ON *.*'*) note "root@'%' 授权: $(printf '%s' "$grants" | head -n 1)" ;;
      *) warn "root@'%' 已创建，但授权里没看到全局权限，请手动执行 SHOW GRANTS FOR 'root'@'%' 确认（输出: ${grants:-空}）" ;;
    esac
  fi
  remote=$(mysql --defaults-extra-file="$ROOT_CNF" -N -s -e "SELECT CONCAT(user, '@', host) FROM mysql.user WHERE user='${MYSQL_USER}' AND host='%'" 2>/dev/null || true)
  [ -n "$remote" ] || die "${MYSQL_USER}@'%' 账号未创建成功"
  grants=$(mysql --defaults-extra-file="$ROOT_CNF" -N -s -e "SHOW GRANTS FOR '${MYSQL_USER}'@'%'" 2>&1 || true)
  case "$grants" in
    *"${MYSQL_DATABASE}"*) note "${MYSQL_USER}@'%' 授权: $(printf '%s' "$grants" | head -n 1)" ;;
    *) warn "${MYSQL_USER}@'%' 已创建，但授权里没出现库名 ${MYSQL_DATABASE}，请手动执行 SHOW GRANTS FOR '${MYSQL_USER}'@'%' 确认（输出: ${grants:-空}）" ;;
  esac

  note "root / ${MYSQL_USER} 账号 TCP 登录通过，@'%' 账号已确认"
}

setup_mysql() {
  log '[5/7] MySQL'
  if [ "$SKIP_MYSQL" -eq 1 ]; then
    note 'SKIP_MYSQL=1，跳过'
    return 0
  fi
  apt_install mysql-server

  MYSQL_VERSION=$(mysqld --version 2>/dev/null | sed -nE 's/.*Ver ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')
  if [ -z "$MYSQL_VERSION" ]; then
    MYSQL_VERSION=$(mysql --version 2>/dev/null | sed -nE 's/.*Distrib ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')
  fi
  MYSQL_VERSION=${MYSQL_VERSION:-0.0.0}
  if ! version_ge "$MYSQL_VERSION" '8.0.13'; then
    die "MySQL 需 ≥8.0.13（项目要求表达式默认值与窗口函数），当前: $MYSQL_VERSION"
  fi
  note "MySQL $MYSQL_VERSION"

  backup_file "$MYSQL_CONF"
  strip_block "$MYSQL_CONF"
  append_mysql_block

  ROOT_CNF=$(mktemp /tmp/monitor-init-root.XXXXXX)
  TMP_FILES+=("$ROOT_CNF")
  write_client_cnf "$ROOT_CNF" root "$MYSQL_ROOT_PASSWORD"

  systemctl enable mysql >/dev/null 2>&1 || warn 'systemctl enable mysql 失败'
  systemctl restart mysql
  if ! retry 60 1 mysql_ready; then
    die "MySQL 未能启动，查看 journalctl -u mysql 与 /var/log/mysql/error.log，配置见 $MYSQL_CONF"
  fi
  note 'mysqld 已就绪'

  detect_auth_plugin
  ensure_root_access
  provision_accounts
  verify_mysql_accounts
}

# ============================== [6/7] 校验 ==============================

verify_all() {
  log '[6/7] 校验'
  local failed=0

  if [ "$SKIP_NODE" -eq 0 ]; then
    if have node && [ "$(node_major_version)" -ge "$NODE_MIN_MAJOR" ]; then
      note "node $(node -v) / npm $(npm -v)"
    else
      warn "node 未就绪或低于 v${NODE_MIN_MAJOR}"
      failed=1
    fi
  fi

  if [ "$SKIP_NGINX" -eq 0 ]; then
    if systemctl is-active --quiet nginx; then
      note 'nginx 运行中'
    else
      warn 'nginx 未运行'
      failed=1
    fi
    local code
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${NGINX_LISTEN_PORT}/" || true)
    case "$code" in
      502|504) note "入口 http://127.0.0.1:${NGINX_LISTEN_PORT}/ 返回 $code：后端未启动属预期，先跑 node dist/main.js" ;;
      000|'') warn "无法连接 http://127.0.0.1:${NGINX_LISTEN_PORT}/，检查 nginx 监听与安全组" ;;
      *) note "入口 http://127.0.0.1:${NGINX_LISTEN_PORT}/ → HTTP $code" ;;
    esac
  fi

  if [ "$SKIP_REDIS" -eq 0 ]; then
    if systemctl is-active --quiet redis-server && redis_ready; then
      note "Redis 运行中：$(redis_cli config get maxmemory-policy 2>/dev/null | tail -n 1) / DB 5 可用"
    else
      warn 'Redis 未就绪'
      failed=1
    fi
  fi

  if [ "$SKIP_MYSQL" -eq 0 ]; then
    if systemctl is-active --quiet mysql && mysql_ready; then
      note 'MySQL 运行中，账号可用'
    else
      warn 'MySQL 未就绪'
      failed=1
    fi
  fi

  if [ "$failed" -ne 0 ]; then
    die '存在未通过的服务，请按上方提示修复后重跑本脚本'
  fi
}

# ============================== [7/7] 输出 ==============================

print_summary() {
  log '[7/7] 安装结果'
  printf '============================================\n'

  if have node && [ "$SKIP_NODE" -eq 0 ]; then
    printf 'node     程序: %s\n' "$(command -v node)"
    printf '         版本: %s    npm: %s\n' "$(node -v 2>/dev/null || echo 未知)" "$(npm -v 2>/dev/null || echo 未知)"
    printf '         npm registry: %s\n' "$(npm config get registry 2>/dev/null || echo 未知)"
    printf '         安装目录: %s\n' "$NODE_INSTALL_DIR"
  else
    printf 'node     已跳过或未安装\n'
  fi

  if have nginx && [ "$SKIP_NGINX" -eq 0 ]; then
    local nginx_main
    nginx_main=$(nginx -t 2>&1 | sed -nE 's/.*configuration file (\/[^ ]+) syntax.*/\1/p' | head -n 1)
    nginx_main=${nginx_main:-/etc/nginx/nginx.conf}
    printf 'nginx    程序: %s\n' "$(command -v nginx)"
    printf '         主配置: %s\n' "$nginx_main"
    printf '         站点配置: %s\n' "$NGINX_SITE_FILE"
    printf '         日志目录: /var/log/nginx         目录: /etc/nginx\n'
    printf '         端口: %s → 反代 http://%s:%s\n' "$NGINX_LISTEN_PORT" "$BACKEND_HOST" "$BACKEND_PORT"
  else
    printf 'nginx    已跳过或未安装\n'
  fi

  if have redis-cli && [ "$SKIP_REDIS" -eq 0 ]; then
    local redis_dir redis_port
    redis_dir=$(redis_cli config get dir 2>/dev/null | tail -n 1)
    redis_dir=${redis_dir:-/var/lib/redis}
    redis_port=$(redis_cli config get port 2>/dev/null | tail -n 1)
    redis_port=${redis_port:-$REDIS_PORT}
    printf 'redis    程序: %s\n' "$(command -v redis-server)"
    printf '         配置: %s\n' "$REDIS_CONF"
    printf '         数据目录: %s（CONFIG GET dir）   日志: journalctl -u redis-server\n' "$redis_dir"
    local redis_auth
    if [ -n "$REDIS_PASSWORD" ]; then
      redis_auth='已设置密码'
    else
      redis_auth='未设密码（protected-mode no）'
    fi
    printf '         端口: %s（CONFIG GET port）   认证: %s\n' "$redis_port" "$redis_auth"
    printf '         maxmemory: %s   maxmemory-policy: noeviction\n' "$REDIS_MAXMEMORY"
  else
    printf 'redis    已跳过或未安装\n'
  fi

  if have mysqld && [ "$SKIP_MYSQL" -eq 0 ]; then
    local mdatadir mport mlog
    if [ -n "$ROOT_CNF" ] && [ -f "$ROOT_CNF" ]; then
      mdatadir=$(mysql --defaults-extra-file="$ROOT_CNF" -N -s -e 'SELECT @@datadir' 2>/dev/null || echo 未知)
      mport=$(mysql --defaults-extra-file="$ROOT_CNF" -N -s -e 'SELECT @@port' 2>/dev/null || echo "$MYSQL_PORT")
      mlog=$(mysql --defaults-extra-file="$ROOT_CNF" -N -s -e 'SELECT @@log_error' 2>/dev/null || echo /var/log/mysql/error.log)
    else
      mdatadir='未知'
      mport=$MYSQL_PORT
      mlog='/var/log/mysql/error.log'
    fi
    printf 'mysql    程序: %s\n' "$(command -v mysqld)"
    printf '         配置: %s\n' "$MYSQL_CONF"
    printf '         数据目录: %s（@@datadir）   错误日志: %s\n' "$mdatadir" "${mlog:-/var/log/mysql/error.log}"
    printf '         端口: %s（@@port）   版本: %s\n' "$mport" "$MYSQL_VERSION"
    printf '         账号: root@%s / %s@%s / %s@localhost   库: %s\n' \
      "'%'" "$MYSQL_USER" "'%'" "$MYSQL_USER" "$MYSQL_DATABASE"
  else
    printf 'mysql    已跳过或未安装\n'
  fi

  printf '============================================\n'

  if [ "$GENERATED_MYSQL_ROOT" -eq 1 ]; then
    printf '自动生成的 MySQL root 密码: %s\n' "$MYSQL_ROOT_PASSWORD"
  else
    printf 'MySQL root 密码: ******（由执行者提供，未在脚本中保存）\n'
  fi
  if [ -n "$REDIS_PASSWORD" ]; then
    printf 'Redis 密码: ******\n'
  else
    printf 'Redis 密码: 未设置（bind 0.0.0.0 + protected-mode no，任何可达客户端均可读写）\n'
  fi

  cat <<NEXT_STEP

★ 下一步
  1) 在 monitor-backend/.env 中写入：
       PORT=<与反代端口一致>            HOST=127.0.0.1
       MYSQL_HOST=127.0.0.1  MYSQL_PORT=${MYSQL_PORT}  MYSQL_DATABASE=${MYSQL_DATABASE}
       MYSQL_USERNAME=${MYSQL_USER}  MYSQL_PASSWORD=<本次配置的密码>
       MYSQL_ADMIN_USERNAME=root  MYSQL_ADMIN_PASSWORD=<root 密码>
       REDIS_HOST=127.0.0.1  REDIS_PORT=${REDIS_PORT}  REDIS_PASSWORD=<见上文>  REDIS_DB=5
  2) 3306 / 6379 已监听 0.0.0.0：请在云安全组限制来源网段，不要直接暴露公网
  3) 部署后端产物后执行：node dist/db-init.js → node dist/main.js
  4) 反代入口：http://<域名或IP>:${NGINX_LISTEN_PORT}/ → http://${BACKEND_HOST}:${BACKEND_PORT}
NEXT_STEP
}

# ============================== 流程入口 ==============================

parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --check-only|-c) CHECK_ONLY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数: $arg（可用 --check-only / --help）" ;;
    esac
  done
}

main() {
  parse_args "$@"
  step_env_check

  if [ "$CHECK_ONLY" -eq 1 ]; then
    log '环境检查完成（--check-only，未做任何安装或修改）'
    note "将通过检测的项目：Node ≥v${NODE_MIN_MAJOR}、nginx（端口 ${NGINX_LISTEN_PORT}）、Redis（端口 ${REDIS_PORT}）、MySQL（端口 ${MYSQL_PORT}）"
    note "反代目标：http://${BACKEND_HOST}:${BACKEND_PORT}"
    return 0
  fi

  install_node
  setup_nginx
  setup_redis
  setup_mysql
  verify_all
  print_summary
}

main "$@"
