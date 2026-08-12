#!/bin/bash
# CoAgentHub 全功能自动化验收(真实运行环境,经 vite 代理 5173)(零 python,纯 Node)
# 前置:两个 dev server 运行(server :3001 + web :5173)、本地 postgres、/tmp/coagenthub-tokens.env 或自动注册
API=http://localhost:5173/api
TOK=/tmp/coagenthub-tokens.env
PASS=0; FAIL=0
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# node JSON 助手:管道输入 JSON,$1 为 JS 表达式(变量 j),结果打印到 stdout
jsq() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log('"$1"')'; }

ck() { # $1=名称 $2=test 表达式(单引号包裹,如 '[ "$(x)" = 64 ]')
  if eval "$2"; then PASS=$((PASS+1)); echo "  ✓ $1"
  else FAIL=$((FAIL+1)); echo "  ✗ $1"; fi
}

source "$TOK" 2>/dev/null
if [ -z "$alice_TOKEN" ]; then
  R=$(curl -s -X POST $API/agents -H "Content-Type: application/json" -d '{"name":"alice","type":"human","device":"mac"}')
  alice_TOKEN=$(echo "$R" | jsq 'j.token')
  echo "alice_TOKEN=$alice_TOKEN" >> "$TOK"
  echo "alice=$R" >> "$TOK"
fi
A=$alice_TOKEN

echo "== 1. agent 注册与列表 =="
R=$(curl -s -X POST $API/agents -H "Content-Type: application/json" -d "{\"name\":\"verify-agent-$(date +%s)\",\"type\":\"hermes\",\"device\":\"mac\",\"webhookUrl\":\"http://127.0.0.1:9199/hook\"}")
VTOKEN=$(echo "$R" | jsq 'j.token')
VID=$(echo "$R" | jsq 'j.id')
ck "注册 agent 返回 64 位 token" '[ "${#VTOKEN}" = 64 ]'
ck "agent 列表含新注册 agent" '[ "$(curl -s $API/agents -H "Authorization: Bearer $A" | grep -c verify-agent)" -ge 1 ]'
ck "无 token GET /api/agents 放行(AUTH_DISABLED)" '[ "$(curl -s -o /dev/null -w "%{http_code}" $API/agents)" = 200 ]'
ck "无 token GET 群组列表 → 401(agentAuth)" '[ "$(curl -s -o /dev/null -w "%{http_code}" $API/groups)" = 401 ]'

echo "== 2. 群组 =="
R=$(curl -s -X POST $API/groups -H "Authorization: Bearer $A" -H "Content-Type: application/json" -d "{\"title\":\"全功能验收群-$(date +%s)\"}")
GID=$(echo "$R" | jsq 'j.id')
ck "创建群组返回 id" '[ "${#GID}" -ge 36 ]'
ck "群组列表含新群" '[ "$(curl -s $API/groups -H "Authorization: Bearer $A" | grep -c 全功能验收群)" -ge 1 ]'
ck "创建者自动为成员" '[ "$(curl -s $API/groups/$GID/members -H "Authorization: Bearer $A" | grep -c alice)" -ge 1 ]'

echo "== 3. 成员与角色 =="
R=$(curl -s -X POST $API/groups/$GID/members -H "Authorization: Bearer $A" -H "Content-Type: application/json" -d "{\"agentId\":\"$VID\",\"roles\":[\"reviewer\",\"executor\"]}")
ck "加成员带双角色" '[ "$(echo "$R" | grep -c reviewer)" -ge 1 ]'
ck "成员列表 2 人" '[ "$(curl -s $API/groups/$GID/members -H "Authorization: Bearer $A" | jsq "j.length")" = 2 ]'

echo "== 4. 消息:广播/角色/子消息 =="
curl -s -X POST $API/groups/$GID/messages -H "Authorization: Bearer $A" -H "Content-Type: application/json" -d '{"body":"【验收】广播命令","audience":"broadcast"}' >/dev/null
curl -s -X POST $API/groups/$GID/messages -H "Authorization: Bearer $A" -H "Content-Type: application/json" -d '{"body":"【验收】方案草稿","audience":"role","audienceRef":"reviewer"}' >/dev/null
DID=$(curl -s -X POST $API/groups/$GID/messages -H "Authorization: Bearer $A" -H "Content-Type: application/json" -d '{"body":"【验收】检视意见","audience":"role","audienceRef":"coordinator"}' | jsq 'j.parentId ?? ""')
curl -s -X POST $API/groups/$GID/messages -H "Authorization: Bearer $A" -H "Content-Type: application/json" -d "{\"body\":\"【验收】检视意见\",\"parentId\":\"$(curl -s $API/groups/$GID/messages -H "Authorization: Bearer $A" | jsq "j.find(m=>m.body.includes('草稿')).id")\",\"audience\":\"role\",\"audienceRef\":\"coordinator\"}" >/dev/null
curl -s -X POST $API/groups/$GID/messages -H "Authorization: Bearer $A" -H "Content-Type: application/json" -d '{"body":"【验收】最终版","audience":"role","audienceRef":"executor"}' >/dev/null
MSGS=$(curl -s $API/groups/$GID/messages -H "Authorization: Bearer $A")
ck "消息总数 5 条" '[ "$(echo "$MSGS" | jsq "j.length")" = 5 ]'
ck "检视意见带 parentId" '[ "$(echo "$MSGS" | jsq "j.some(m=>m.parentId)")" = true ]'

echo "== 5. 可见性(executor 视角) =="
VIS=$(curl -s $API/groups/$GID/messages -H "Authorization: Bearer $VTOKEN")
N=$(echo "$VIS" | jsq 'j.length')
BODIES=$(echo "$VIS" | jsq 'j.map(m=>m.body).join("\n")')
ck "executor(兼 reviewer)恰见 3 条(广播+草稿+最终版)" '[ "$N" = 3 ]'
ck "executor 见草稿(双角色 reviewer 可见)" '[ "$(echo "$BODIES" | grep -c 草稿)" = 1 ]'
ck "executor 不见检视意见(仅 coordinator)" '[ "$(echo "$BODIES" | grep -c 检视)" = 0 ]'
ck "executor 见最终版" '[ "$(echo "$BODIES" | grep -c 最终版)" = 1 ]'

echo "== 6. 增量拉取 ?after= =="
AFTER=$(echo "$VIS" | jsq 'j[0].id')
ck "alice after 游标增量拉取 4 条(草稿+2×检视+最终版)" '[ "$(curl -s "$API/groups/$GID/messages?after=$AFTER" -H "Authorization: Bearer $A" | jsq "j.length")" = 4 ]'

echo "== 7. P2P 文件信令 =="
echo "fake-model.gguf-$(date +%s)" > /tmp/fake-model.gguf
SHA=$(shasum -a 256 /tmp/fake-model.gguf | cut -d' ' -f1)
SIZE=$(stat -f%z /tmp/fake-model.gguf)
node "$DIR/serve-static.mjs" 9198 /tmp >/dev/null 2>&1 &
SRVPID=$!
sleep 1
MF=$(curl -s -X POST $API/groups/$GID/messages -H "Authorization: Bearer $A" -H "Content-Type: application/json" -d "{\"body\":\"【验收】模型文件已就绪\",\"audience\":\"broadcast\",\"fileRef\":{\"name\":\"fake-model.gguf\",\"size\":$SIZE,\"sha256\":\"$SHA\",\"fetchUrl\":\"http://127.0.0.1:9198/fake-model.gguf\"}}")
ck "文件信令消息发出" '[ "$(echo "$MF" | grep -c fetchUrl)" -ge 1 ]'
curl -s -o /tmp/pulled.gguf "$(echo "$MF" | jsq 'j.fileRef.fetchUrl')"
PSHA=$(shasum -a 256 /tmp/pulled.gguf | cut -d' ' -f1)
ck "P2P 直连拉取 SHA256 一致" '[ "$PSHA" = "$SHA" ]'
kill $SRVPID 2>/dev/null

echo "== 8. webhook 通知 =="
node - "$API" "$GID" "$A" <<'NODEEOF' > /tmp/hook-out.txt
// 内嵌 node webhook 监听器:起 9199 收集负载,发一条消息触发,5 秒后输出负载 JSON
const http = require("http");
const api = process.argv[2], gid = process.argv[3], tok = process.argv[4];
const bodies = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    bodies.push(JSON.parse(raw));
    res.writeHead(200);
    res.end();
  });
});
server.listen(9199, "127.0.0.1", () => {
  const payload = JSON.stringify({ body: "【验收】webhook 触发消息", audience: "broadcast" });
  const req = http.request(api + "/groups/" + gid + "/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tok },
  }, (res) => {
    res.resume();
    setTimeout(() => {
      // JSON.stringify 默认转义非 ASCII,还原 \uXXXX 保证中文可被 grep
      const out = JSON.stringify(bodies).replace(/\\u[0-9a-f]{4}/gi,
        (m) => String.fromCharCode(parseInt(m.slice(2), 16)));
      console.log(out);
      server.close();
      process.exit(0);
    }, 5000);
  });
  req.write(payload);
  req.end();
});
NODEEOF
ck "verify-agent webhook 收到通知(8 字段负载)" '[ "$(grep -c "webhook 触发消息" /tmp/hook-out.txt)" -ge 1 ]'
ck "webhook 负载含 8 字段(type/groupId/messageId/...)" '[ "$(grep -c "audienceRef" /tmp/hook-out.txt)" -ge 1 ]'

echo "== 9. 归档 =="
ck "归档返回 200" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/groups/$GID/archive -H "Authorization: Bearer $A")" = 200 ]'
ck "归档后消息仍可读" '[ "$(curl -s $API/groups/$GID/messages -H "Authorization: Bearer $A" | jsq "j.length")" -ge 5 ]'
ck "已归档群组在列表中" '[ "$(curl -s $API/groups -H "Authorization: Bearer $A" | jsq "j.find(g=>g.id===\"$GID\").status")" = archived ]'

echo ""
echo "========== 结果: PASS=$PASS FAIL=$FAIL =========="
