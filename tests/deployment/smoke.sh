#!/usr/bin/env bash
# Runs only inside the disposable Ubuntu container. No host ports or system files
# are mounted, and no live ACME or Cloudflare requests are performed.
set -Eeuo pipefail
report_failure() {
  local status=$1 line=$2 command=$3
  printf 'Smoke test failed at line %s (exit %s): %s\n' "$line" "$status" "$command" >&2
  tail -80 /tmp/receiver.log /var/log/nginx/error.log 2>/dev/null || true
  exit "$status"
}
trap 'report_failure "$?" "$LINENO" "$BASH_COMMAND"' ERR

# nginx reload returns before its new workers have taken over. During hostname
# changes an old worker can still serve the previous certificate or upstream.
# Retry read-only probes, retaining TLS verification and a bounded timeout.
get_https() {
  curl --fail --silent --show-error --retry 10 --retry-all-errors \
    --retry-delay 1 --max-time 5 --noproxy '*' "$1"
}
cd /source
shellcheck install.sh deploy/install-lib.sh tests/deployment/systemctl tests/deployment/certbot tests/deployment/smoke.sh
mkdir -p /run/systemd/system /etc/letsencrypt/live/shared-example
cp tests/deployment/systemctl /usr/bin/systemctl
cp tests/deployment/certbot /usr/local/bin/certbot
chmod +x /usr/bin/systemctl /usr/local/bin/certbot
cat > /usr/local/bin/nginx <<'NGINX'
#!/bin/sh
if [ "$1" = '-t' ] && [ -f /tmp/fail-nginx-once ]; then
  rm /tmp/fail-nginx-once
  exit 1
fi
exec /usr/sbin/nginx "$@"
NGINX
chmod +x /usr/local/bin/nginx
lineage=/etc/letsencrypt/live/shared-example
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=*.example.test' \
  -addext 'subjectAltName=DNS:*.example.test' -keyout "$lineage/privkey.pem" -out "$lineage/fullchain.pem" 2>/dev/null
cp "$lineage/fullchain.pem" /usr/local/share/ca-certificates/receiver-test.crt
update-ca-certificates >/dev/null
printf '127.0.0.1 reports.example.test reports.other.test\n' >> /etc/hosts
./install.sh reports.example.test --port 3111
[[ ! -e /tmp/certbot-calls ]]
grep -q 'shared-example/fullchain.pem' /etc/nginx/sites-available/csptool-receiver
[[ $(curl --silent --output /dev/null --write-out '%{http_code}' http://reports.example.test/) == 308 ]]
get_https https://reports.example.test/healthz | grep -q '"status":"ok"'
curl --fail --silent https://reports.example.test/violations -H 'Content-Type: application/csp-report' \
  --data '{"csp-report":{"document-uri":"https://page.example.test","blocked-uri":"inline"}}'
node=$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' /etc/systemd/system/csptool-receiver.service)
"$node" <<'JS'
const WebSocket = require('/opt/csptool-receiver/current/node_modules/ws');
const socket = new WebSocket('wss://reports.example.test/socket.io/?EIO=4&transport=websocket', {
  ca: require('node:fs').readFileSync('/etc/letsencrypt/live/shared-example/fullchain.pem'),
});
const timeout = setTimeout(() => { console.error('WebSocket proxy timed out'); process.exit(1); }, 5000);
socket.on('error', error => { console.error(error); process.exit(1); });
socket.on('message', message => {
  if (!message.toString().startsWith('0')) process.exit(1);
  clearTimeout(timeout);
  socket.close();
});
JS
systemd-analyze verify /etc/systemd/system/csptool-receiver.service
grep -qx 'WantedBy=multi-user.target' /etc/systemd/system/csptool-receiver.service
grep -qx 'Restart=on-failure' /etc/systemd/system/csptool-receiver.service
grep -qx 'enable csptool-receiver nginx certbot.timer' /tmp/systemctl-calls
./install.sh reports.example.test --port 3111
get_https https://reports.example.test/violations | grep -q 'https://page.example.test'
[[ $(stat -c '%U' /var/lib/csptool-receiver/violations.db) == csptool-receiver ]]
ss -ltn | grep -q '127.0.0.1:3111'
previous=$(readlink /opt/csptool-receiver/current)
cp /etc/nginx/sites-available/csptool-receiver /tmp/previous-nginx
# A configuration validation failure must leave the prior deployment running.
touch /tmp/fail-nginx-once
if ./install.sh reports.example.test --port 3112; then echo 'Expected failure' >&2; exit 1; fi
[[ $(readlink /opt/csptool-receiver/current) == "$previous" ]]
cmp /etc/nginx/sites-available/csptool-receiver /tmp/previous-nginx
get_https https://reports.example.test/healthz | grep -q '"status":"ok"'
# No pre-existing certificate: verify DNS plugin arguments, protected persistent
# credentials, and a successful HTTPS deployment after simulated issuance.
printf 'dns_cloudflare_api_token = test-only-not-a-real-token\n' > /tmp/cloudflare.ini
./install.sh reports.other.test --node-major 26 --port 3111 --email admin@other.test --cloudflare-credentials /tmp/cloudflare.ini
[[ $(stat -c '%a:%U' /etc/letsencrypt/csptool-receiver/cloudflare.ini) == 600:root ]]
grep -q -- '--dns-cloudflare-credentials /etc/letsencrypt/csptool-receiver/cloudflare.ini' /tmp/certbot-calls
grep -q -- '--dns-cloudflare-propagation-seconds 60' /tmp/certbot-calls
/etc/letsencrypt/renewal-hooks/deploy/csptool-receiver-nginx
get_https https://reports.other.test/healthz | grep -q '"status":"ok"'
get_https https://reports.other.test/violations | grep -q 'https://page.example.test'
echo 'Ubuntu deployment smoke test passed (Certbot and systemd lifecycle simulated).'
