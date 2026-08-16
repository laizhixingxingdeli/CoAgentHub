import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileDir, maxFileUploadBytes } from "@server/lib/config";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

/**
 * LAN file transfer API — pure disk, zero database.
 *
 * Mounted at `/api/file` without any authGuard: on a trusted LAN every device
 * can push/pull files without login. All operations stay inside FILE_DIR and
 * file names are sanitized (basename only, no separators / `..`) to prevent
 * path traversal.
 */

const FILE_DIR = fileDir();

/**
 * 单文件上传上限(P0 输入上限):env `MAX_FILE_UPLOAD_BYTES` 可覆盖,
 * 默认 200MB(非法值兜底见 lib/config.ts)。防止局域网内一条超大请求直接
 * 打爆磁盘/内存。
 */
const MAX_FILE_UPLOAD_BYTES = maxFileUploadBytes();

/**
 * multipart 请求体比文件本身多出 framing(边界行 + part 头,通常 <1KB),
 * Content-Length 预检须留出余量,否则恰好等于上限的文件会被误拒。
 */
const MULTIPART_FRAMING_ALLOWANCE = 1024 * 1024;

/** Reject empty names, `.`/`..`, and anything containing path separators or NUL. */
function sanitizeFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return null;
  }
  if (/[/\\\0]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Resolve a sanitized file name inside FILE_DIR, or null on traversal attempts. */
function resolveFilePath(name: string): string | null {
  const safe = sanitizeFileName(name);
  if (!safe) {
    return null;
  }
  const full = path.resolve(FILE_DIR, safe);
  const root = path.resolve(FILE_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return null;
  }
  return full;
}

/**
 * 把 File 对象流式写入目标路径(带背压),避免 `Buffer.from(arrayBuffer())`
 * 在 formData() 缓冲之上再产生一份整块内存拷贝。
 */
async function streamFileToDisk(file: File, dest: string): Promise<void> {
  // File#stream() 是 web ReadableStream;经 Node 流管道写入磁盘,
  // pipeline 自动处理背压与错误传播。
  await pipeline(
    Readable.fromWeb(
      file.stream() as unknown as import("node:stream/web").ReadableStream,
    ),
    createWriteStream(dest),
  );
}

const downloadUrl = (name: string) => `/api/file/${encodeURIComponent(name)}`;

const app = new Hono()
  .post(
    "/upload",
    describeRoute({
      tags: ["File"],
      description: "Upload a file to the LAN file store",
      responses: {
        200: {
          description: "File uploaded",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  size: { type: "number" },
                  url: { type: "string" },
                },
              },
            },
          },
        },
        400: {
          description: "Missing or invalid file",
        },
      },
    }),
    async (c) => {
      // Content-Length 预检:声明长度已超上限的请求在解析 multipart 前直接
      // 拒绝,避免超大请求被整体读进内存打爆进程(framing 余量防误拒恰好
      // 等于上限的文件;逐文件精确校验在下方 file.size)。
      const contentLength = Number(c.req.header("content-length"));
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_FILE_UPLOAD_BYTES + MULTIPART_FRAMING_ALLOWANCE
      ) {
        return c.json({ message: "文件过大" }, 400);
      }
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return c.json({ message: "缺少文件字段(file)" }, 400);
      }
      const name = sanitizeFileName(file.name);
      if (!name) {
        return c.json({ message: "非法文件名" }, 400);
      }
      // 拿到 file.size 后立刻判断,超限直接 400,不落盘(不等读完再拒)。
      if (file.size > MAX_FILE_UPLOAD_BYTES) {
        return c.json({ message: "文件过大" }, 400);
      }
      await mkdir(FILE_DIR, { recursive: true });
      try {
        // 流式写盘:File → 磁盘,不构造整块 Buffer(仍受 file.size 上限约束)。
        await streamFileToDisk(file, path.join(FILE_DIR, name));
      } catch {
        // 写入失败(磁盘满/中断):清理半成品后按 500 返回。
        await unlink(path.join(FILE_DIR, name)).catch(() => {});
        return c.json({ message: "文件写入失败" }, 500);
      }
      return c.json({ name, size: file.size, url: downloadUrl(name) });
    },
  )
  .get(
    "/list",
    describeRoute({
      tags: ["File"],
      description: "List files in the LAN file store",
      responses: {
        200: {
          description: "File list",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    size: { type: "number" },
                    mtime: { type: "string" },
                    url: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    }),
    async (c) => {
      await mkdir(FILE_DIR, { recursive: true });
      const entries = await readdir(FILE_DIR, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const info = await stat(path.join(FILE_DIR, entry.name));
        files.push({
          name: entry.name,
          size: info.size,
          mtime: info.mtime.toISOString(),
          url: downloadUrl(entry.name),
        });
      }
      return c.json(files);
    },
  )
  .get(
    "/:name",
    describeRoute({
      tags: ["File"],
      description: "Download a file from the LAN file store",
      responses: {
        200: {
          description: "File content",
          content: {
            "application/octet-stream": {},
          },
        },
        404: {
          description: "File not found",
        },
      },
    }),
    async (c) => {
      const name = c.req.param("name");
      const fullPath = resolveFilePath(name);
      if (!fullPath) {
        return c.json({ message: "非法文件名" }, 400);
      }
      try {
        const info = await stat(fullPath);
        c.header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
        c.header("Content-Type", "application/octet-stream");
        c.header("Content-Length", String(info.size));
        // 流式下载:createReadStream → web ReadableStream,不整块读入内存。
        return c.body(
          Readable.toWeb(
            createReadStream(fullPath),
          ) as unknown as ReadableStream,
        );
      } catch {
        return c.json({ message: "文件不存在" }, 404);
      }
    },
  )
  .delete(
    "/:name",
    describeRoute({
      tags: ["File"],
      description: "Delete a file from the LAN file store",
      responses: {
        200: {
          description: "File deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                },
              },
            },
          },
        },
        404: {
          description: "File not found",
        },
      },
    }),
    async (c) => {
      const name = c.req.param("name");
      const fullPath = resolveFilePath(name);
      if (!fullPath) {
        return c.json({ message: "非法文件名" }, 400);
      }
      try {
        await unlink(fullPath);
        return c.json({ success: true });
      } catch {
        return c.json({ message: "文件不存在" }, 404);
      }
    },
  );

export default app;
