-- R3:reviewer 不再是执行器配置——清掉指向不存在配置的悬空绑定。
--
-- 本迁移独立于 0028 存在:T3 把该 UPDATE 内联进 0028,但已应用 0028 的老
-- 安装不会重放已记录的迁移,导致 reviewer 绑定永久残留。拆为独立迁移后,
-- Drizzle migrator 会对老库按 journal 发现 0029 并执行,新库则紧随 0028
-- 依次执行。
--
-- 幂等:仅命中 executor_key = 'reviewer' 的行,重复执行是 no-op。
UPDATE "participant" SET "executor_key" = NULL WHERE "executor_key" = 'reviewer';
