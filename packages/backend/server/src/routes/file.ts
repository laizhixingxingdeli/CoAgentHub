import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
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

const FILE_DIR = path.resolve(process.env.FILE_DIR ?? "data/files");

/**
 * 单文件上传上限(P0 输入上限):env `MAX_FILE_UPLOAD_BYTES` 可覆盖,
 * 默认 200MB,防止局域网内一条超大请求直接打爆磁盘/内存。
 * env 值非法(非正数)时回落默认值并告警,避免误配置悄悄禁用上限。
 */
const MAX_FILE_UPLOAD_BYTES = (() => {
  const parsed = Number(process.env.MAX_FILE_UPLOAD_BYTES);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  if (process.env.MAX_FILE_UPLOAD_BYTES !== undefined) {
    console.warn(
      `[file] MAX_FILE_UPLOAD_BYTES 非法(${process.env.MAX_FILE_UPLOAD_BYTES}),回落默认 200MB`,
    );
  }
  return 200 * 1024 * 1024;
})();

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
      await writeFile(
        path.join(FILE_DIR, name),
        Buffer.from(await file.arrayBuffer()),
      );
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
        const data = await readFile(fullPath);
        c.header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
        c.header("Content-Type", "application/octet-stream");
        c.header("Content-Length", String(data.byteLength));
        return c.body(data);
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
