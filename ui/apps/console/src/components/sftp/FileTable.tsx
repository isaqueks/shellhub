import { useMemo } from "react";
import { IconButton } from "@shellhub/design-system/primitives";
import {
  FolderIcon,
  DocumentIcon,
  LinkIcon,
  ArrowDownTrayIcon,
  PencilIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { type FileEntry, formatSize } from "@/components/sftp/sftpProtocol";

interface FileTableProps {
  entries: FileEntry[];
  loading?: boolean;
  onOpenDir: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}

const DASH = "—";

function formatMtime(mtime: number): string {
  if (mtime === 0) return DASH;
  return new Date(mtime * 1000).toLocaleString();
}

export default function FileTable({
  entries,
  loading = false,
  onOpenDir,
  onDownload,
  onRename,
  onDelete,
}: FileTableProps) {
  // Directories first, then case-insensitive name ascending. Sort a copy so the
  // caller's array is never mutated.
  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }),
    [entries],
  );

  const headerCell =
    "px-3 py-2 text-2xs uppercase tracking-wide text-text-muted font-medium";

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className={`${headerCell} text-left`}>Name</th>
            <th className={`${headerCell} text-right`}>Size</th>
            <th className={`${headerCell} text-left`}>Modified</th>
            <th className={`${headerCell} text-left`}>Permissions</th>
            <th className={`${headerCell} w-0`} aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td
                colSpan={5}
                className="px-3 py-10 text-center text-xs text-text-muted"
              >
                Loading&hellip;
              </td>
            </tr>
          ) : sorted.length === 0 ? (
            <tr>
              <td
                colSpan={5}
                className="px-3 py-10 text-center text-xs text-text-muted"
              >
                This folder is empty
              </td>
            </tr>
          ) : (
            sorted.map((entry) => {
              const clickable = entry.isDir || entry.isLink;
              const Icon = entry.isDir
                ? FolderIcon
                : entry.isLink
                  ? LinkIcon
                  : DocumentIcon;
              return (
                <tr
                  key={entry.path}
                  onClick={clickable ? () => onOpenDir(entry) : undefined}
                  className={`group border-b border-border-light transition-colors hover:bg-hover-subtle ${
                    clickable ? "cursor-pointer" : ""
                  }`}
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <Icon
                        className={`w-4 h-4 shrink-0 ${
                          entry.isDir
                            ? "text-accent-cyan"
                            : entry.isLink
                              ? "text-accent-yellow"
                              : "text-text-muted"
                        }`}
                        strokeWidth={1.75}
                      />
                      <span
                        className={`truncate text-xs ${
                          clickable
                            ? "text-text-primary group-hover:text-primary"
                            : "text-text-primary"
                        }`}
                        title={entry.name}
                      >
                        {entry.name}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs text-text-secondary whitespace-nowrap tabular-nums">
                    {entry.isDir ? DASH : formatSize(entry.size)}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-text-secondary whitespace-nowrap">
                    {formatMtime(entry.mtime)}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono text-2xs text-text-muted">
                      {entry.mode}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      {!entry.isDir && (
                        <IconButton
                          size="sm"
                          aria-label={`Download ${entry.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDownload(entry);
                          }}
                        >
                          <ArrowDownTrayIcon
                            className="w-3.5 h-3.5"
                            strokeWidth={1.75}
                          />
                        </IconButton>
                      )}
                      <IconButton
                        size="sm"
                        aria-label={`Rename ${entry.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRename(entry);
                        }}
                      >
                        <PencilIcon className="w-3.5 h-3.5" strokeWidth={1.75} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        variant="danger"
                        aria-label={`Delete ${entry.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(entry);
                        }}
                      >
                        <TrashIcon className="w-3.5 h-3.5" strokeWidth={1.75} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
