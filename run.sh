#!/usr/bin/env bash
# Bayan launcher.
#   ./run.sh          start the service in the foreground
#   ./run.sh --open   start it in the background and open it in your browser
#   ./run.sh --stop   stop whatever is listening on the port
set -euo pipefail
cd "$(dirname "$0")"

PORT="${BAYAN_PORT:-8150}"
URL="http://127.0.0.1:${PORT}/"

port_owner() {
  ss -ltnp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p"$" { if (match($0, /pid=([0-9]+)/, a)) print a[1] }'
}

case "${1:-}" in
  --stop)
    pid="$(port_owner || true)"
    if [ -n "${pid:-}" ]; then kill "$pid" && echo "stopped pid $pid"; else echo "nothing listening on ${PORT}"; fi
    exit 0
    ;;
  --open) OPEN=1 ;;
  "") OPEN=0 ;;
  *) echo "usage: $0 [--open|--stop]" >&2; exit 2 ;;
esac

if [ ! -x .venv/bin/python ]; then
  echo "creating .venv…"
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi

if curl -sf --max-time 2 "${URL}healthz" >/dev/null 2>&1; then
  echo "Bayan already running at ${URL}"
  if [ "$OPEN" = 1 ]; then
    xdg-open "${URL}" >/dev/null 2>&1 &
  fi
  exit 0
fi

if [ "$OPEN" = 1 ]; then
  mkdir -p data
  setsid .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "${PORT}" \
      >> data/server.log 2>&1 &
  for _ in $(seq 1 60); do
    if curl -sf --max-time 2 "${URL}healthz" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  if ! curl -sf --max-time 2 "${URL}healthz" >/dev/null 2>&1; then
    echo "service did not start; see data/server.log" >&2
    exit 1
  fi
  xdg-open "${URL}" >/dev/null 2>&1 &
  echo "Bayan running at ${URL}"
  exit 0
fi

exec .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "${PORT}"
