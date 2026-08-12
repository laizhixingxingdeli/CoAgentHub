#!/bin/bash
# webhook 驱动 agent 常驻循环演示编排(零 python,纯 Node)
set -e
API=http://localhost:5173/api
source /tmp/coagenthub-tokens.env
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# node JSON 助手:管道输入 JSON,$1 为 JS 表达式(变量 j),结果打印到 stdout
jsq() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log('"$1"')'; }

echo "== 1. 注册 hook-agent(带 webhookUrl 指向 9199)=="
HA=$(curl -s -X POST $API/agents -H "Content-Type: application/json" \
  -d '{"name":"hook-agent","type":"hermes","device":"mac","webhookUrl":"http://127.0.0.1:9199/hook"}')
HA_ID=$(echo "$HA" | jsq 'j.id')
HA_TOKEN=$(echo "$HA" | jsq 'j.token')
echo "  hook-agent=$HA_ID"

echo "== 2. alice 建群 + 加 hook-agent =="
G=$(curl -s -X POST $API/groups -H "Content-Type: application/json" -H "Authorization: Bearer $alice_TOKEN" -d '{"title":"webhook 驱动演示(常驻 agent)"}')
GID=$(echo "$G" | jsq 'j.id')
curl -s -X POST $API/groups/$GID/members -H "Content-Type: application/json" -H "Authorization: Bearer $alice_TOKEN" -d "{\"agentId\":\"$HA_ID\",\"roles\":[\"executor\"]}" >/dev/null
echo "  GID=$GID"

echo "== 3. 后台起 webhook 接收器(常驻 agent 监听)=="
HOOK_PORT=9199 AGENT_TOKEN="$HA_TOKEN" GROUP_ID="$GID" \
  node "$DIR/coagenthub-webhook-agent.mjs" > /tmp/coagenthub-hook-agent.log 2>&1 &
HPID=$!
sleep 1
echo "  接收器 pid=$HPID (日志 /tmp/coagenthub-hook-agent.log)"

echo "== 4. alice 发训练命令(触发 webhook)=="
curl -s -X POST $API/groups/$GID/messages -H "Content-Type: application/json" -H "Authorization: Bearer $alice_TOKEN" \
  -d '{"body":"请训练一个 DeepSeek 演示模型并汇报进度","audience":"broadcast"}' >/dev/null
echo "  已发送,等待 webhook 推送 + agent 自动响应..."
sleep 3

echo ""
echo "== 5. 接收器日志 =="
cat /tmp/coagenthub-hook-agent.log

echo ""
echo "== 6. 验证群里消息(应出现 hook-agent 自动回复)=="
curl -s "$API/groups/$GID/messages" -H "Authorization: Bearer $alice_TOKEN" | jsq 'j.map(m=>"  ["+m.senderId.slice(0,8)+"] "+m.body).join("\n")'

kill $HPID 2>/dev/null
echo ""
echo "== 演示完成,GID=$GID =="
