# 界面截图与画板尺寸比对

## 行为

- `node scripts/web-shot.mjs <路由> --name <名字>` 在当前 worktree 用无界面 Chrome 打开 `src/web` 的 hash 路由并截视口。路由不带开头的 `#` 或 `/`；以 `#`、`/` 开头或含盘符时退出非 0，并提示写成 `missions/<id>`、`pool`、`projects`。
- 本机小服务只听 `127.0.0.1` 随机端口。静态文件复用 `serveStatic`，root 为当前目录下的 `src/web`。`/api/*` 只转发 GET 到 `--api`（默认 `http://127.0.0.1:3101`），其它方法回 405 且不转发。
- 浏览器固定 `--headless=new`、`--remote-debugging-port=0`、独立 `--user-data-dir`。从 `DevToolsActivePort` 连接，不连 9222，不调用会打开真窗口的 `--version`。退出时关掉自己起的浏览器并删除该临时目录。
- `--measure` 与 `--pair` 的选择器在截图前量全部匹配元素，整数视口框和列出的计算样式写入 `.coagent-artifacts/shots/<名字>.json`。`--compare` 读 `.impeccable/reference/layout.xml` 的对应 `<board>`，画板根的画布 x/y 不计，子节点沿父层累加后与第一个匹配元素比 x/y/w/h。不超过 `--tol`（默认 2）记 ✓，否则 ✗；找不到记缺失。有超差时退出码仍为 0。参数错、找不到浏览器、服务连不上、页面 20 秒内没加载完为非 0。
- 截图与 json 不进入机器验证，也不提交进 Git。
