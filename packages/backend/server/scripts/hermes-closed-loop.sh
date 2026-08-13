#!/bin/bash
# Hermes 真实接入闭环(可重跑):注册 participant → 建群 → 训练信令 → P2P 拉取校验(零 python,纯 Node)
# 前置:server :3001 + web :5173 运行、/tmp/coagenthub-tokens.env 存在(alice 等 token)
# 用法:bash scripts/hermes-closed-loop.sh
set -e
API=http://localhost:5173/api
TOK=/tmp/coagenthub-tokens.env
source "$TOK"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# node JSON 助手:管道输入 JSON,$1 为 JS 表达式(变量 j),结果打印到 stdout
jsq() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log('"$1"')'; }

echo "== 1. 注册 hermes-win(训练端)+ hermes-mac(拉取端)=="
WIN=$(curl -s -X POST $API/participants -H "Content-Type: application/json" -d '{"name":"hermes-win","type":"hermes","device":"win","webhookUrl":"http://127.0.0.1:9199/hook"}')
WIN_ID=$(echo "$WIN" | jsq 'j.id')
WIN_TOKEN=$(echo "$WIN" | jsq 'j.token')
MAC=$(curl -s -X POST $API/participants -H "Content-Type: application/json" -d '{"name":"hermes-mac","type":"hermes","device":"mac","webhookUrl":"http://127.0.0.1:9199/hook"}')
MAC_ID=$(echo "$MAC" | jsq 'j.id')
MAC_TOKEN=$(echo "$MAC" | jsq 'j.token')
echo "  hermes-win=$WIN_ID / hermes-mac=$MAC_ID"

echo "== 2. alice 建群 =="
G=$(curl -s -X POST $API/groups -H "Content-Type: application/json" -H "Authorization: Bearer $alice_TOKEN" -d '{"title":"Hermes 训练闭环(真实接入)"}')
GID=$(echo "$G" | jsq 'j.id')
echo "  GID=$GID"

echo "== 3. hermes-win 入群(specialist)=="
curl -s -X POST $API/groups/$GID/members -H "Content-Type: application/json" -H "Authorization: Bearer $alice_TOKEN" -d "{\"participantId\":\"$WIN_ID\",\"roles\":[\"specialist\"]}" >/dev/null
curl -s -X POST $API/groups/$GID/members -H "Content-Type: application/json" -H "Authorization: Bearer $alice_TOKEN" -d "{\"participantId\":\"$MAC_ID\",\"roles\":[\"human\"]}" >/dev/null
echo "  hermes-win(specialist)+ hermes-mac(human)已加入"

echo "== 4. alice 广播训练命令 =="
curl -s -X POST $API/groups/$GID/messages -H "Content-Type: application/json" -H "Authorization: Bearer $alice_TOKEN" -d '{"body":"请在 win 端训练 DeepSeek 蒸馏小模型,训练完成后把 GGUF 文件交付到 mac 端","audience":"broadcast"}' >/dev/null

echo "== 5. hermes-win 增量拉取,确认收到命令 =="
MSGS=$(curl -s "$API/groups/$GID/messages" -H "Authorization: Bearer $WIN_TOKEN")
echo "$MSGS" | jsq 'j.map(m=>"  ["+m.senderId.slice(0,8)+"] "+m.body.slice(0,50)).join("\n")'

echo "== 6. 生成真实训练产物(模拟 GGUF 文件,2MB 可复现,种子 42)=="
F=/tmp/DeepSeek-R1-Distill-Qwen-1.5B-Q4.gguf
node - "$F" <<'NODEEOF'
// 与原 python 版字节一致:GGUF 魔数 + <I 版本 + <Q 元数据长度 + 元数据 + 2MB LCG(种子 42)
const fs = require("fs");
const crypto = require("crypto");
const p = process.argv[2];
const meta = Buffer.from("DeepSeek-R1-Distill-Qwen-1.5B Q4_K_M distilled by hermes-win");
const data = Buffer.allocUnsafe(4 + 4 + 8 + meta.length + 2 * 1024 * 1024);
let off = 0;
data.write("GGUF", off); off += 4;
data.writeUInt32LE(3, off); off += 4;
data.writeBigUInt64LE(BigInt(meta.length), off); off += 8;
meta.copy(data, off); off += meta.length;
let seed = 42n;
for (let i = 0; i < (2 * 1024 * 1024) / 8; i++) {
  seed = (seed * 1103515245n + 12345n) & 0x7fffffffn;
  data.writeBigUInt64LE(seed, off);
  off += 8;
}
fs.writeFileSync(p, data);
console.log(`  生成 ${data.length} 字节 SHA256=${crypto.createHash("sha256").update(data).digest("hex")}`);
NODEEOF
SHA=$(shasum -a 256 "$F" | cut -d' ' -f1)
SIZE=$(stat -f%z "$F")

echo "== 7. 起本地 HTTP 服务(9198)提供文件 =="
node "$DIR/serve-static.mjs" 9198 /tmp >/dev/null 2>&1 &
SRV=$!
sleep 1

echo "== 8. hermes-win 发布文件信令 =="
curl -s -X POST "$API/groups/$GID/messages" -H "Content-Type: application/json" -H "Authorization: Bearer $WIN_TOKEN" -d "{
  \"body\": \"训练完成!GGUF 模型已就绪,请从 mac 端直连拉取\",
  \"audience\": \"broadcast\",
  \"fileRef\": {\"name\":\"DeepSeek-R1-Distill-Qwen-1.5B-Q4.gguf\",\"size\":$SIZE,\"sha256\":\"$SHA\",\"fetchUrl\":\"http://127.0.0.1:9198/DeepSeek-R1-Distill-Qwen-1.5B-Q4.gguf\"}
}" >/dev/null

echo "== 9. hermes-mac 增量拉取,解析文件信令 =="
MSGS=$(curl -s "$API/groups/$GID/messages" -H "Authorization: Bearer $MAC_TOKEN")
FR=$(echo "$MSGS" | jsq 'j.find(m=>m.fileRef).fileRef.fetchUrl')
NAME=$(echo "$MSGS" | jsq 'j.find(m=>m.fileRef).fileRef.name')
EXPECT_SHA=$(echo "$MSGS" | jsq 'j.find(m=>m.fileRef).fileRef.sha256')
echo "  fetchUrl=$FR"

echo "== 10. P2P 直连下载 + SHA256 校验 =="
curl -s -o "/tmp/downloaded-$NAME" "$FR"
GOT=$(shasum -a 256 "/tmp/downloaded-$NAME" | cut -d' ' -f1)
SIZE_GOT=$(stat -f%z "/tmp/downloaded-$NAME")
echo "  下载 $SIZE_GOT 字节"
if [ "$GOT" != "$EXPECT_SHA" ]; then
  echo "  ❌ SHA256 不匹配:期望 $EXPECT_SHA 实际 $GOT"; kill $SRV; exit 1
fi
echo "  ✅ SHA256 校验通过:$GOT"

echo "== 11. hermes-mac 群里汇报交付完成 =="
curl -s -X POST "$API/groups/$GID/messages" -H "Content-Type: application/json" -H "Authorization: Bearer $MAC_TOKEN" -d "{
  \"body\": \"✅ mac 端已直连拉取模型并校验通过(SHA256=$GOT, $SIZE_GOT 字节),交付完成\",
  \"audience\": \"broadcast\"}" >/dev/null

echo "== 12. 清理 http 服务 + 收尾 =="
kill $SRV 2>/dev/null
echo "=== 闭环完成,GID=$GID ==="
echo "浏览器查看:http://localhost:5173/groups/$GID"
