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
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return c.json({ message: "缺少文件字段(file)" }, 400);
      }
      const name = sanitizeFileName(file.name);
      if (!name) {
        return c.json({ message: "非法文件名" }, 400);
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
