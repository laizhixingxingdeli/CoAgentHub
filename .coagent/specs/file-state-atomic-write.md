# 文件状态原子提交短暂改名拒绝重试

FileStateStore 的主状态文件先写临时文件再 rename 覆盖。仅遇到 Windows 常见临时拒绝 `EPERM`、`EBUSY`、`EACCES` 时短退避有限重试（最多十次、总等待不超过约两秒）；其他错误立即抛出，重试耗尽仍抛原错误并维持事务原有的内存回滚。归档包改名路径不受本规则影响。测试可在临时状态路径注入改名函数：前两次 EPERM，第三次成功，状态提交并可重载。

源：`src/application/file-store.ts`；验证：`test/file-store-compaction.test.ts`。
