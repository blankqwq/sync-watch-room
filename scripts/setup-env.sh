#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname "$script_dir")
env_file="$project_root/.env"
watch_domain=""
turn_domain=""
public_ip=""
app_port="8088"
turn_secret=""
force="false"

usage() {
  cat <<'EOF'
Usage: scripts/setup-env.sh [options]

Options:
  --domain DOMAIN       Public watch-room domain, for example watch.example.com
  --turn-domain DOMAIN  Public TURN domain, for example turn.example.com
  --public-ip IPV4      Server public IPv4; empty enables automatic detection
  --app-port PORT       Local frontend port used by Nginx (default: 8088)
  --secret SECRET       Existing TURN shared secret; generated when omitted
  --output FILE         Output path (default: project .env)
  --force               Replace an existing output file without confirmation
  -h, --help            Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain)
      watch_domain=${2:-}
      shift 2
      ;;
    --turn-domain)
      turn_domain=${2:-}
      shift 2
      ;;
    --public-ip)
      public_ip=${2:-}
      shift 2
      ;;
    --app-port)
      app_port=${2:-}
      shift 2
      ;;
    --secret)
      turn_secret=${2:-}
      shift 2
      ;;
    --output)
      env_file=${2:-}
      shift 2
      ;;
    --force)
      force="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

prompt() {
  label=$1
  default_value=$2
  printf "%s [%s]: " "$label" "$default_value" >&2
  IFS= read -r answer
  if [ -n "$answer" ]; then printf "%s" "$answer"; else printf "%s" "$default_value"; fi
}

if [ -z "$watch_domain" ]; then
  if [ ! -t 0 ]; then
    echo "--domain is required in non-interactive mode" >&2
    exit 1
  fi
  watch_domain=$(prompt "Watch domain" "watch.example.com")
fi

if [ -z "$turn_domain" ]; then
  case "$watch_domain" in
    *.*.*) base_domain=${watch_domain#*.} ;;
    *) base_domain=$watch_domain ;;
  esac
  default_turn_domain="turn.$base_domain"
  if [ -t 0 ]; then
    turn_domain=$(prompt "TURN domain" "$default_turn_domain")
  else
    turn_domain=$default_turn_domain
  fi
fi

if [ -z "$public_ip" ] && [ -t 0 ]; then
  public_ip=$(prompt "Server public IPv4 (empty to auto-detect)" "")
fi

case "$watch_domain" in
  ""|*[!A-Za-z0-9.-]*|.*|*.) echo "Invalid watch domain: $watch_domain" >&2; exit 1 ;;
esac
case "$turn_domain" in
  ""|*[!A-Za-z0-9.-]*|.*|*.) echo "Invalid TURN domain: $turn_domain" >&2; exit 1 ;;
esac
case "$public_ip" in
  *[!0-9.]*|.*|*.) echo "Invalid public IPv4: $public_ip" >&2; exit 1 ;;
esac
if [ -n "$public_ip" ] && ! printf "%s\n" "$public_ip" | awk -F. '
  NF != 4 { exit 1 }
  { for (i = 1; i <= 4; i += 1) if ($i !~ /^[0-9]+$/ || $i > 255) exit 1 }
'; then
  echo "Invalid public IPv4: $public_ip" >&2
  exit 1
fi
case "$app_port" in
  ""|*[!0-9]*) echo "Invalid app port: $app_port" >&2; exit 1 ;;
esac
if [ "$app_port" -lt 1 ] || [ "$app_port" -gt 65535 ]; then
  echo "App port must be between 1 and 65535" >&2
  exit 1
fi

if [ -f "$env_file" ] && [ "$force" != "true" ]; then
  if [ ! -t 0 ]; then
    echo "$env_file already exists; use --force to replace it" >&2
    exit 1
  fi
  printf "%s already exists. Replace it? [y/N]: " "$env_file" >&2
  IFS= read -r confirm
  case "$confirm" in
    y|Y|yes|YES) ;;
    *) echo "Cancelled"; exit 0 ;;
  esac
fi

if [ -z "$turn_secret" ]; then
  if command -v openssl >/dev/null 2>&1; then
    turn_secret=$(openssl rand -hex 32)
  elif command -v node >/dev/null 2>&1; then
    turn_secret=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  else
    echo "openssl or Node.js is required to generate TURN_SHARED_SECRET" >&2
    exit 1
  fi
fi

if [ "${#turn_secret}" -lt 32 ]; then
  echo "TURN shared secret must contain at least 32 characters" >&2
  exit 1
fi

if command -v openssl >/dev/null 2>&1; then
  admin_token=$(openssl rand -hex 32)
  postgres_password=$(openssl rand -hex 24)
else
  admin_token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  postgres_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')
fi
postgres_user=watch_room
postgres_db=watch_room
postgres_port=55432
database_url=""
existing_env_value() { awk -v key="$1" 'index($0, key "=")==1 { sub(/^[^=]*=/, ""); print; exit }' "$env_file"; }
if [ -f "$env_file" ]; then
  existing_postgres_password=$(existing_env_value POSTGRES_PASSWORD)
  if [ -n "$existing_postgres_password" ]; then postgres_password=$existing_postgres_password; fi
  postgres_user=$(existing_env_value POSTGRES_USER); postgres_user=${postgres_user:-watch_room}
  postgres_db=$(existing_env_value POSTGRES_DB); postgres_db=${postgres_db:-watch_room}
  postgres_port=$(existing_env_value POSTGRES_PORT); postgres_port=${postgres_port:-55432}
  database_url=$(existing_env_value DATABASE_URL)
fi
database_url=${database_url:-postgresql://$postgres_user:$postgres_password@127.0.0.1:$postgres_port/$postgres_db}
case "$turn_secret" in
  *[!A-Za-z0-9_-]*) echo "TURN shared secret contains unsupported characters" >&2; exit 1 ;;
esac

if [ -n "$public_ip" ]; then
  detect_external_ip="false"
else
  detect_external_ip="true"
fi

umask 077
temp_file=$(mktemp "${env_file}.tmp.XXXXXX")
trap 'rm -f "$temp_file"' EXIT HUP INT TERM

cat >"$temp_file" <<EOF
# Generated by scripts/setup-env.sh
APP_PORT=$app_port
APP_BIND=127.0.0.1
VITE_WS_URL=

ALLOWED_ORIGINS=https://$watch_domain
ADMIN_TOKEN=$admin_token
DATA_DIR=
POSTGRES_USER=$postgres_user
POSTGRES_DB=$postgres_db
POSTGRES_PASSWORD=$postgres_password
POSTGRES_PORT=$postgres_port
DATABASE_URL=$database_url
MACCMS_SOURCES=
OSS_REGION=
OSS_BUCKET=
OSS_ACCESS_KEY_ID=
OSS_ACCESS_KEY_SECRET=
OSS_PUBLIC_URL=

STUN_URLS=stun:$turn_domain:3478
TURN_URLS=turn:$turn_domain:3478?transport=udp,turn:$turn_domain:3478?transport=tcp
TURN_SHARED_SECRET=$turn_secret
TURN_CREDENTIAL_TTL_SECONDS=3600
TURN_REALM=$watch_domain
TURN_PORT=3478
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
TURN_EXTERNAL_IP=$public_ip
TURN_RELAY_IP=
TURN_DETECT_EXTERNAL_IP=$detect_external_ip
TURN_MAX_BPS=1048576
EOF

mv "$temp_file" "$env_file"
trap - EXIT HUP INT TERM
chmod 600 "$env_file"

echo "Created $env_file"
echo "Watch origin: https://$watch_domain"
echo "TURN endpoint: $turn_domain:3478"
echo "Next: docker compose up -d --build --wait"
