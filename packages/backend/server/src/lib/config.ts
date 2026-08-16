import { resolve } from "node:path";

/**
 * 统一配置读取:把散落在各模块的 env 读取(默认值 + 非法值兜底)收敛到一处,
 * 避免同类默认值在多处重复/漂移。读取时机与原来一致(模块加载时求值一次),
 * 测试通过「先设 env 再 import 路由模块」保持兼容(见 test/setup.ts)。
 *
 * 调度策略(dispatch-policy.json)、执行超时(EXECUTOR_TIMEOUT_MS)与执行器
 * 配置仍在各自领域模块(executors.ts / executor-runner.ts)读取——它们有
 * 结构性默认值与专用解析逻辑,不并入此处。
 */

/** CORS 允许的来源(env `CORS_ORIGIN`,逗号分隔;缺省 http://localhost:3000)。 */
export function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN;
  if (!raw || raw.trim().length === 0) {
    return ["http://localhost:3000"];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 文件存储目录(env `FILE_DIR`;缺省 <cwd>/data/files,相对路径解析为绝对路径)。 */
export function fileDir(): string {
  return resolve(process.env.FILE_DIR ?? "data/files");
}

/**
 * 单文件上传上限(env `MAX_FILE_UPLOAD_BYTES`;缺省 200MB)。env 值非法
 * (非正数)时回落默认值并告警,避免误配置悄悄禁用上限。
 */
export function maxFileUploadBytes(): number {
  const parsed = Number(process.env.MAX_FILE_UPLOAD_BYTES);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  if (process.env.MAX_FILE_UPLOAD_BYTES !== undefined) {
    console.warn(
      `[config] MAX_FILE_UPLOAD_BYTES 非法(${process.env.MAX_FILE_UPLOAD_BYTES}),回落默认 200MB`,
    );
  }
  return 200 * 1024 * 1024;
}

/** 服务端口(env `PORT`;缺省 3001,与 index.ts 原逻辑一致)。 */
export function serverPort(): number {
  const n = Number(process.env.PORT);
  return Number.isFinite(n) && n > 0 ? n : 3001;
}
