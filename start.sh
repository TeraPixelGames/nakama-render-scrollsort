#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set"
  exit 1
fi

if [ -z "${PORT:-}" ]; then
  echo "PORT is not set (Render should set this automatically)"
  exit 1
fi

DB_ADDR="$(echo "$DATABASE_URL" | sed -E 's|^postgres(ql)?://||')"
echo "Using DB address: $DB_ADDR"
echo "Using public listen PORT: $PORT"

echo "Running Nakama migrations..."
/nakama/nakama migrate up --database.address "$DB_ADDR"

echo "Starting Nakama on internal ports (7354 API, 7355 console)..."

# Allow overrides via environment; export so envsubst can see them
export NAKAMA_SOCKET_PORT="7354"
export NAKAMA_CONSOLE_PORT="7355"

/nakama/nakama \
  --name nakama1 \
  --database.address "$DB_ADDR" \
  --logger.level "${NAKAMA_LOG_LEVEL:-INFO}" \
  --socket.server_key "${NAKAMA_SERVER_KEY}" \
  --socket.port "$NAKAMA_SOCKET_PORT" \
  --console.username "${NAKAMA_CONSOLE_USERNAME}" \
  --console.password "${NAKAMA_CONSOLE_PASSWORD}" \
  --console.port "$NAKAMA_CONSOLE_PORT" &

NAKAMA_PID=$!

echo "Rendering nginx config..."
envsubst '${PORT} ${NAKAMA_SOCKET_PORT} ${NAKAMA_CONSOLE_PORT}' \
  < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf


echo "Starting nginx reverse proxy..."
exec nginx -g "daemon off;"


