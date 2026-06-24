#!/usr/bin/env bash
# 코드스페이스가 켜질 때마다 철거의정석 서버를 백그라운드로 자동 실행한다.
set -e
cd "$(dirname "$0")/.."

# 이미 떠 있으면 중복 실행하지 않는다.
if pgrep -f "node server.js" > /dev/null; then
  echo "server already running"
  exit 0
fi

mkdir -p logs
nohup node server.js > logs/server.log 2>&1 &
echo "server started (pid $!) — logs/server.log"
