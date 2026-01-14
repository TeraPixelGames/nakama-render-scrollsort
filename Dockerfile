FROM registry.heroiclabs.com/heroiclabs/nakama:3.22.0

# Install nginx + envsubst (for templating PORT into nginx config)
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx gettext-base ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy nginx config template + startup script
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY nakama/modules /nakama/data/modules
COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/start.sh"]

