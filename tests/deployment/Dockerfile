FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
    && apt-get update && apt-get install -y --no-install-recommends \
       ca-certificates curl xz-utils openssl nginx certbot python3-certbot-dns-cloudflare \
       python3 make g++ systemd shellcheck iproute2 \
    && rm -rf /var/lib/apt/lists/*
CMD ["bash", "/source/tests/deployment/smoke.sh"]
