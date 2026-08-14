import { Download, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

type FileItem = {
  name: string;
  size: number;
  mtime: string;
  url: string;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN");
  } catch {
    return iso;
  }
}

export default function FilesPage() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/file/list");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setFiles(await res.json());
    } catch (e) {
      setError(
        t("files.error.loadFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    setUploading(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/file/upload", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
      }
      setMessage(t("files.uploaded", { name: file.name }));
      await loadFiles();
    } catch (e) {
      setError(
        t("files.error.uploadFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(t("files.confirm.delete", { name }))) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/file/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setMessage(t("files.deleted", { name }));
      await loadFiles();
    } catch (e) {
      setError(
        t("files.error.deleteFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{t("files.title")}</h2>
          <p className="text-muted-foreground text-sm">{t("files.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadFiles}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            {t("common.refresh")}
          </Button>
          <Button variant="default" size="sm" asChild>
            <label className="cursor-pointer">
              <Upload />
              {uploading ? t("common.uploading") : t("files.upload")}
              <input
                type="file"
                className="hidden"
                disabled={uploading}
                onChange={handleUpload}
              />
            </label>
          </Button>
        </div>
      </div>

      {message && (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          {message}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card shadow-sm">
        {files.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {loading ? t("common.loading") : t("files.empty")}
          </div>
        ) : (
          <>
            {/* Mobile: card list */}
            <div className="flex flex-col gap-3 p-3 md:hidden">
              {files.map((file) => (
                <div
                  key={file.name}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                >
                  <span className="break-all text-sm font-medium">
                    {file.name}
                  </span>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{formatSize(file.size)}</span>
                    <span>{formatTime(file.mtime)}</span>
                  </div>
                  <div className="mt-1 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      asChild
                    >
                      <a href={file.url} download>
                        <Download />
                        {t("common.download")}
                      </a>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-red-600 hover:text-red-700"
                      onClick={() => handleDelete(file.name)}
                    >
                      <Trash2 />
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop: table */}
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">
                    {t("files.table.name")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("files.table.size")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("files.table.mtime")}
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    {t("files.table.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.name} className="border-b last:border-0">
                    <td className="px-4 py-3 break-all">{file.name}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatSize(file.size)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatTime(file.mtime)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <a href={file.url} download>
                            <Download />
                            {t("common.download")}
                          </a>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => handleDelete(file.name)}
                        >
                          <Trash2 />
                          {t("common.delete")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
