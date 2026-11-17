#!/usr/bin/env bash
# Functions are separate so argument validation and real TLS selection can be tested.
die() { echo "Error: $*" >&2; exit 1; }

valid_hostname() {
  local value=$1 label
  [[ ${#value} -le 253 && $value =~ ^[a-zA-Z0-9.-]+$ && $value == *.* && ! $value =~ ^[0-9.]+$ ]] || return 1
  local -a labels
  IFS=. read -r -a labels <<< "$value"
  [[ $value != *. ]] || return 1
  for label in "${labels[@]}"; do
    [[ ${#label} -ge 1 && ${#label} -le 63 && $label =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ ]] || return 1
  done
}

find_certificate() {
  local base=$1 host=$2 preferred=$3 lineage
  local -a candidates
  if [[ -n $preferred ]]; then candidates=("$base/$preferred")
  else candidates=("$base/$host" "$base"/*); fi
  for lineage in "${candidates[@]}"; do
    [[ -f $lineage/fullchain.pem && -f $lineage/privkey.pem ]] || continue
    [[ $(basename "$lineage") =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || continue
    if openssl x509 -in "$lineage/fullchain.pem" -noout -checkhost "$host" >/dev/null 2>&1; then
      printf '%s\n' "$lineage"
      return 0
    fi
  done
  return 1
}

validate_certificate() {
  local lineage=$1 host=$2 cert_public key_public
  openssl x509 -in "$lineage/fullchain.pem" -noout -checkhost "$host" >/dev/null 2>&1 || return 1
  openssl x509 -in "$lineage/fullchain.pem" -noout -checkend 0 >/dev/null 2>&1 || return 1
  cert_public=$(openssl x509 -in "$lineage/fullchain.pem" -pubkey -noout) || return 1
  key_public=$(openssl pkey -in "$lineage/privkey.pem" -passin pass: -pubout) || return 1
  [[ $cert_public == "$key_public" ]]
}

render_nginx() {
  local host=$1 port=$2 lineage=$3
  cat <<NGINX
# Managed by csptool-receiver install.sh
map \$http_upgrade \$csptool_connection_upgrade {
    default upgrade;
    '' close;
}
server {
    listen 80;
    listen [::]:80;
    server_name $host;
    return 308 https://$host\$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $host;
    ssl_certificate $lineage/fullchain.pem;
    ssl_certificate_key $lineage/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 100k;
    location / {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$csptool_connection_upgrade;
        proxy_read_timeout 75s;
    }
}
NGINX
}

render_unit() {
  local node=$1
  cat <<UNIT
# Managed by csptool-receiver install.sh
[Unit]
Description=CSP violation receiver
After=network.target

[Service]
Type=simple
User=csptool-receiver
Group=csptool-receiver
WorkingDirectory=/opt/csptool-receiver/current
EnvironmentFile=/etc/csptool-receiver/receiver.env
ExecStart=$node /opt/csptool-receiver/current/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
StateDirectory=csptool-receiver
StateDirectoryMode=0750
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/csptool-receiver
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT
}
