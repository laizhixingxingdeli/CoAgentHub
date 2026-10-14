# 资源池健康查询

GET /api/pools 保持原有七天用量统计与全历史最近失败 hints；扫描每处理完一个 Mission（包括读取失败）让出一次事件循环。

createApi 的 poolsHealthCacheMs 缺省 0，关闭缓存与并发合并；正数时按实例缓存成功的最终脱敏响应，TTL 从扫描成功完成起算。并发请求共用同代扫描，失败不缓存。常驻服务装配为 15000ms。

?fresh=1 绕过已完成缓存并刷新，可共享当前同代在途真实扫描。身份与权限逐请求检查，不缓存身份或未脱敏数据。

POST /api/pools、POST /api/pools/<role>/configure、POST /api/pools/<id>/circuit/reset 成功后立即使缓存与当前在途代次失效；新请求不得加入旧扫描，旧扫描不得回填新缓存。