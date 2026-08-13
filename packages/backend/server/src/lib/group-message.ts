/**
 * 群消息写入(阶段2-票1 抽取):实现已随架构债清理迁入
 * `lib/services/message-service.ts`;本文件仅 re-export,保持
 * 既有 `@server/lib/group-message` 导入路径兼容,行为零变化。
 */

export {
  insertGroupMessage,
  MAX_REPLY_DEPTH,
  type InsertGroupMessageInput,
} from "./services/message-service";
