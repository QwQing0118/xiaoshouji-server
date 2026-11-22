#!/bin/sh
cd "$(dirname "$0")" || exit 1
(nohup node server.js >> run.log 2>&1 &)
sleep 2
curl -s http://127.0.0.1:8787/api/ping || echo "启动失败，看 run.log"
