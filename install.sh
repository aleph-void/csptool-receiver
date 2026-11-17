#!/usr/bin/env bash
# Install this checkout on Ubuntu 26.x. Never source credentials as shell code.
set -Eeuo pipefail

SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/install-lib.sh
source "$SOURCE_DIR/deploy/install-lib.sh"

usage() {
  cat <<'USAGE'
Usage: sudo ./install.sh HOSTNAME [options]

  --cloudflare-credentials FILE  Certbot Cloudflare INI (default: /etc/letsencrypt/cloudflare.ini)
  --email EMAIL                  ACME account email, required for a new certificate
  --cert-name NAME               Reuse a specific /etc/letsencrypt/live/NAME lineage
  --port PORT                    Loopback backend port (default: 3000)
  --node-major 24|26             Dedicated Node runtime (default: 24)
  --propagation-seconds SECONDS  Cloudflare DNS wait (default: 60)
  --dry-run                     Print the plan without making changes
  --help                        Show this help

Existing matching Certbot certificates are reused without Cloudflare credentials.
New certificates use Cloudflare DNS-01 and accept the Let's Encrypt subscriber
agreement. Credentials are copied root-only to a persistent renewal location.
One receiver instance is managed per server. Rerunning upgrades the app while
preserving /var/lib/csptool-receiver/violations.db and previous release directories.
USAGE
}

SITE_HOST=''
CREDENTIALS=/etc/letsencrypt/cloudflare.ini
ACME_EMAIL=''
CERT_NAME=''
APP_PORT=3000
NODE_MAJOR=24
PROPAGATION_SECONDS=60
DRY_RUN=false
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --cloudflare-credentials|--email|--cert-name|--port|--node-major|--propagation-seconds)
      (($# >= 2)) && [[ -n $2 && $2 != --* ]] || die "$1 requires a value"
      case "$1" in
        --cloudflare-credentials) CREDENTIALS=$2 ;;
        --email) ACME_EMAIL=$2 ;;
        --cert-name) CERT_NAME=$2 ;;
        --port) APP_PORT=$2 ;;
        --node-major) NODE_MAJOR=$2 ;;
        --propagation-seconds) PROPAGATION_SECONDS=$2 ;;
      esac
      shift 2 ;;
    -*) die "Unknown option: $1" ;;
    *) [[ -z $SITE_HOST ]] || die 'Only one hostname may be supplied'; SITE_HOST=${1,,}; shift ;;
  esac
done
valid_hostname "$SITE_HOST" || die 'Supply a DNS hostname, such as reports.example.com (no URL, port, or wildcard).'
if [[ ! $APP_PORT =~ ^[1-9][0-9]{0,4}$ ]] || ((APP_PORT < 1024 || APP_PORT > 65535)); then
  die '--port must be between 1024 and 65535'
fi
[[ $NODE_MAJOR == 24 || $NODE_MAJOR == 26 ]] || die '--node-major must be 24 or 26'
if [[ ! $PROPAGATION_SECONDS =~ ^[1-9][0-9]{0,3}$ ]] || ((PROPAGATION_SECONDS > 3600)); then
  die '--propagation-seconds must be between 1 and 3600'
fi
[[ -z $CERT_NAME || $CERT_NAME =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || die 'Invalid Certbot lineage name'
[[ -z $ACME_EMAIL || $ACME_EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die 'Invalid email address'
if $DRY_RUN; then
  printf 'Host: %s\nBackend: 127.0.0.1:%s\nNode: %s\n' "$SITE_HOST" "$APP_PORT" "$NODE_MAJOR"
  printf 'Reuse matching Certbot TLS; otherwise request Cloudflare DNS-01 TLS.\n'
  printf 'Install app under /opt/csptool-receiver; preserve database under /var/lib/csptool-receiver.\n'
  printf 'Configure systemd, HTTPS nginx proxy, HTTP redirect, and certificate renewal.\n'
  exit 0
fi
((EUID == 0)) || die 'Run with sudo or as root.'
# shellcheck source=/dev/null
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 26.* ]] || die 'This installer supports Ubuntu 26.x.'
[[ -d /run/systemd/system ]] || die 'A running systemd system is required.'
for file in package.json package-lock.json server.js src/app.js src/db.js; do
  [[ -f $SOURCE_DIR/$file ]] || die "Missing checkout file: $file"
done
case "$(dpkg --print-architecture)" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) die 'Supported server architectures: amd64 and arm64.' ;;
esac

APP_ROOT=/opt/csptool-receiver
STATE_DIR=/var/lib/csptool-receiver
CONFIG_DIR=/etc/csptool-receiver
SERVICE=csptool-receiver
UNIT_FILE=/etc/systemd/system/csptool-receiver.service
ENV_FILE=$CONFIG_DIR/receiver.env
NGINX_FILE=/etc/nginx/sites-available/csptool-receiver
NGINX_LINK=/etc/nginx/sites-enabled/csptool-receiver
HOOK_FILE=/etc/letsencrypt/renewal-hooks/deploy/csptool-receiver-nginx
MARKER='# Managed by csptool-receiver install.sh'

# Refuse collisions rather than overwriting unrelated administrator files.
for file in "$UNIT_FILE" "$ENV_FILE" "$NGINX_FILE" "$HOOK_FILE"; do
  [[ ! -L $file ]] || die "Refusing to overwrite symlink: $file"
  if [[ -e $file ]] && ! grep -qxF "$MARKER" "$file"; then
    die "Unmanaged file already exists: $file"
  fi
done
if [[ -e $NGINX_LINK || -L $NGINX_LINK ]]; then
  [[ -L $NGINX_LINK && $(readlink "$NGINX_LINK") == "$NGINX_FILE" ]] || die "Unmanaged nginx site: $NGINX_LINK"
fi
[[ ! -e $APP_ROOT/current || -L $APP_ROOT/current ]] || die "$APP_ROOT/current must be a symlink"

# Serialize upgrades before changing packages, configuration, or the running app.
exec 9>/run/lock/csptool-receiver-install.lock
flock -n 9 || die 'Another receiver installation is running.'
WORK_DIR=$(mktemp -d)
TRANSACTION=false
PREVIOUS_CURRENT=''
SERVICE_WAS_ACTIVE=false
NGINX_WAS_ACTIVE=false
LINK_EXISTED=false
cleanup() {
  local result=$?
  trap - EXIT
  if ((result != 0)) && $TRANSACTION; then
    echo 'Installation failed; restoring the previous app link and managed configuration.' >&2
    for file in "$UNIT_FILE" "$ENV_FILE" "$NGINX_FILE" "$HOOK_FILE"; do
      if [[ -f $WORK_DIR/backup$file ]]; then
        cp -p -- "$WORK_DIR/backup$file" "$file"
      else
        rm -f -- "$file"
      fi
    done
    if [[ -n $PREVIOUS_CURRENT ]]; then
      ln -sfn -- "$PREVIOUS_CURRENT" "$APP_ROOT/current"
    else
      rm -f -- "$APP_ROOT/current"
    fi
    $LINK_EXISTED || rm -f -- "$NGINX_LINK"
    systemctl daemon-reload || true
    if $SERVICE_WAS_ACTIVE; then systemctl restart "$SERVICE" || true
    else systemctl disable --now "$SERVICE" || true; fi
    if $NGINX_WAS_ACTIVE; then nginx -t && systemctl reload nginx || true; fi
  fi
  rm -rf -- "$WORK_DIR"
  exit "$result"
}
trap cleanup EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
# Ubuntu 26 ships Node 22; install a dedicated official Node 24/26 runtime below.
apt-get install -y ca-certificates curl xz-utils openssl nginx certbot python3-certbot-dns-cloudflare python3 make g++

TLS_LINEAGE=$(find_certificate /etc/letsencrypt/live "$SITE_HOST" "$CERT_NAME") || true
if [[ -n $TLS_LINEAGE ]]; then
  echo "Using existing Certbot lineage: $TLS_LINEAGE"
  if ! openssl x509 -in "$TLS_LINEAGE/fullchain.pem" -checkend 0 -noout >/dev/null; then
    certbot renew --cert-name "$(basename "$TLS_LINEAGE")" --non-interactive
  fi
else
  [[ -z $CERT_NAME ]] || die "No matching complete certificate in lineage $CERT_NAME"
  [[ -n $ACME_EMAIL ]] || die 'No matching certificate. Supply --email and --cloudflare-credentials to issue one.'
  [[ -r $CREDENTIALS && -f $CREDENTIALS ]] || die "Cloudflare credentials file not readable: $CREDENTIALS"
  install -d -m 0700 /etc/letsencrypt/csptool-receiver
  SAVED_CREDENTIALS=/etc/letsencrypt/csptool-receiver/cloudflare.ini
  if [[ $(realpath "$CREDENTIALS") != "$SAVED_CREDENTIALS" ]]; then
    install -o root -g root -m 0600 "$CREDENTIALS" "$SAVED_CREDENTIALS"
  else
    chown root:root "$SAVED_CREDENTIALS"
    chmod 0600 "$SAVED_CREDENTIALS"
  fi
  certbot certonly --non-interactive --agree-tos --email "$ACME_EMAIL" \
    --dns-cloudflare --dns-cloudflare-credentials "$SAVED_CREDENTIALS" \
    --dns-cloudflare-propagation-seconds "$PROPAGATION_SECONDS" \
    --cert-name "$SITE_HOST" -d "$SITE_HOST" --keep-until-expiring
  TLS_LINEAGE=/etc/letsencrypt/live/$SITE_HOST
fi
validate_certificate "$TLS_LINEAGE" "$SITE_HOST" || die 'Certificate must cover the hostname, be unexpired, and match its private key.'

# TLS validation completes before touching the installed app or nginx configuration.
install -d -m 0755 "$APP_ROOT" "$APP_ROOT/releases" "$APP_ROOT/runtime"
NODE_BASE=https://nodejs.org/dist
curl --fail --silent --show-error --location "$NODE_BASE/latest-v$NODE_MAJOR.x/SHASUMS256.txt" -o "$WORK_DIR/SHASUMS256.txt"
NODE_ARCHIVE=$(awk -v major="$NODE_MAJOR" -v arch="$NODE_ARCH" '$2 ~ "^node-v" major "\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$" { print $2; exit }' "$WORK_DIR/SHASUMS256.txt")
[[ -n $NODE_ARCHIVE ]] || die 'Could not resolve the official Node runtime archive.'
NODE_VERSION=${NODE_ARCHIVE#node-}
NODE_VERSION=${NODE_VERSION%-linux-*}
NODE_DIR=$APP_ROOT/runtime/${NODE_ARCHIVE%.tar.xz}
if [[ ! -x $NODE_DIR/bin/node ]]; then
  curl --fail --silent --show-error --location "$NODE_BASE/$NODE_VERSION/$NODE_ARCHIVE" -o "$WORK_DIR/$NODE_ARCHIVE"
  (cd "$WORK_DIR"; awk -v archive="$NODE_ARCHIVE" '$2 == archive' SHASUMS256.txt | sha256sum --check --strict -)
  tar -xJf "$WORK_DIR/$NODE_ARCHIVE" -C "$APP_ROOT/runtime" --no-same-owner
fi
[[ $("$NODE_DIR/bin/node" -p 'process.versions.node.split(".")[0]') == "$NODE_MAJOR" ]] || die 'Installed Node major does not match request.'

if ! id "$SERVICE" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE"
fi
[[ $(id -u "$SERVICE") != 0 ]] || die 'The receiver service account must not be root.'
install -d -o "$SERVICE" -g "$SERVICE" -m 0750 "$STATE_DIR"
install -d -m 0755 "$CONFIG_DIR"
RELEASE=$(mktemp -d "$APP_ROOT/releases/release-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
install -m 0644 "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$SOURCE_DIR/server.js" "$RELEASE/"
cp -R -- "$SOURCE_DIR/src" "$RELEASE/src"
chown -R "$SERVICE:$SERVICE" "$RELEASE"
# Build native SQLite as the unprivileged service account, never as root.
runuser -u "$SERVICE" -- env PATH="$NODE_DIR/bin:/usr/bin:/bin" \
  "$NODE_DIR/bin/npm" ci --prefix "$RELEASE" --cache "$RELEASE/.npm-cache" --omit=dev --no-audit --no-fund
rm -rf -- "$RELEASE/.npm-cache"
chown -R root:root "$RELEASE"
chmod -R go-w "$RELEASE"
chmod 0755 "$RELEASE"

systemctl is-active --quiet "$SERVICE" && SERVICE_WAS_ACTIVE=true
systemctl is-active --quiet nginx && NGINX_WAS_ACTIVE=true
[[ ! -L $APP_ROOT/current ]] || PREVIOUS_CURRENT=$(readlink "$APP_ROOT/current")
[[ ! -L $NGINX_LINK ]] || LINK_EXISTED=true
for file in "$UNIT_FILE" "$ENV_FILE" "$NGINX_FILE" "$HOOK_FILE"; do
  if [[ -f $file ]]; then
    mkdir -p "$WORK_DIR/backup$(dirname "$file")"
    cp -p -- "$file" "$WORK_DIR/backup$file"
  fi
done
TRANSACTION=true
render_unit "$NODE_DIR/bin/node" > "$WORK_DIR/receiver.service"
render_nginx "$SITE_HOST" "$APP_PORT" "$TLS_LINEAGE" > "$WORK_DIR/receiver.nginx"
cat > "$WORK_DIR/receiver.env" <<ENV
$MARKER
NODE_ENV=production
HOST=127.0.0.1
PORT=$APP_PORT
DB_PATH=$STATE_DIR/violations.db
ENV
install -m 0644 "$WORK_DIR/receiver.service" "$UNIT_FILE"
install -m 0600 "$WORK_DIR/receiver.env" "$ENV_FILE"
install -m 0644 "$WORK_DIR/receiver.nginx" "$NGINX_FILE"
ln -sfn -- "$NGINX_FILE" "$NGINX_LINK"
ln -s -- "$RELEASE" "$WORK_DIR/current"
mv -Tf -- "$WORK_DIR/current" "$APP_ROOT/current"
install -d -m 0755 "$(dirname "$HOOK_FILE")"
cat > "$HOOK_FILE" <<'HOOK'
#!/bin/sh
# Managed by csptool-receiver install.sh
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
HOOK
chmod 0755 "$HOOK_FILE"
nginx -t
systemctl daemon-reload
systemctl enable "$SERVICE" nginx certbot.timer
systemctl restart "$SERVICE"
healthy=false
for ((attempt=0; attempt<30; attempt++)); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$APP_PORT/healthz" >/dev/null; then healthy=true; break; fi
  sleep 1
done
$healthy || die 'Receiver did not become healthy; inspect journalctl -u csptool-receiver.'
systemctl is-active --quiet "$SERVICE" || die 'Receiver service exited during startup.'
systemctl start nginx certbot.timer
systemctl reload nginx
curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 1 --max-time 5 --noproxy '*' --resolve "$SITE_HOST:443:127.0.0.1" "https://$SITE_HOST/healthz" >/dev/null
TRANSACTION=false
printf '\nReceiver ready: https://%s/\nReport endpoint: https://%s/violations\n' "$SITE_HOST" "$SITE_HOST"
printf 'Logs: journalctl -u csptool-receiver -f\nRenewal: systemctl status certbot.timer\n'
