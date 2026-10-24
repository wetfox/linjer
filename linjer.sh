#!/usr/bin/env bash
# Linjer start/stop/status — detached so it survives this shell.
cd "$(dirname "$0")" || exit 1
PIDFILE="linjer.pid"

case "${1:-status}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Linjer already running (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    nohup bun server.ts >> server.log 2>&1 &
    echo $! > "$PIDFILE"
    sleep 1.5
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Linjer started (pid $(cat "$PIDFILE")) — http://$(hostname -I 2>/dev/null | awk '{print $1}'):8787"
    else
      echo "Start FAILED — see server.log"; tail -5 server.log; exit 1
    fi
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null
      sleep 0.5
      kill -9 "$(cat "$PIDFILE")" 2>/dev/null
      rm -f "$PIDFILE"
      echo "Linjer stopped"
    else
      echo "No pidfile — trying to kill any stray bun server.ts"
      for p in $(ps -W 2>/dev/null | awk '/server\.ts/ {print $1}'); do taskkill //F //PID "$p" 2>/dev/null; done
    fi
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "running (pid $(cat "$PIDFILE"))"
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: linjer.sh start|stop|status"; exit 1
    ;;
esac
