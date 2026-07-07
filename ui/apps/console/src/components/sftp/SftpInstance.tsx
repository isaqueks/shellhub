import { useCallback, useEffect, useRef, useState } from "react";
import {
  FolderOpenIcon,
  FolderPlusIcon,
  ArrowUpTrayIcon,
  ArrowPathIcon,
  XMarkIcon,
  MinusIcon,
  ArrowsPointingOutIcon,
  ArrowsPointingInIcon,
  ExclamationCircleIcon,
} from "@heroicons/react/24/outline";
import { Button, IconButton } from "@shellhub/design-system/primitives";
import { generateRandomUUID } from "@/utils/random-uuid";
import { useSftpStore, type SftpSession } from "@/stores/sftpStore";
import { SftpClient, SftpOpError } from "@/api/sftpClient";
import type { FileEntry, SftpProgress, SftpTransfer } from "./sftpProtocol";
import {
  HTTP_CONNECT_ERROR,
  resolveError,
  type TerminalError,
} from "@/components/terminal/terminalErrors";
import Breadcrumb from "./Breadcrumb";
import FileTable from "./FileTable";
import TransferList from "./TransferList";
import UploadDropzone from "./UploadDropzone";
import SftpErrorBanner from "./SftpErrorBanner";

/** POSIX path helpers — the remote filesystem always uses forward slashes. */
function joinPath(dir: string, name: string): string {
  if (!dir || dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function dirName(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function SftpInstance({
  session,
}: {
  session: SftpSession;
  visible: boolean;
}) {
  const clientRef = useRef<SftpClient | null>(null);
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<TerminalError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<SftpTransfer[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { minimize, toggleFullscreen, close } = useSftpStore();
  const isFullscreen = session.state === "fullscreen";

  const upsertTransfer = useCallback((transfer: SftpTransfer) => {
    setTransfers((prev) => {
      const idx = prev.findIndex((t) => t.id === transfer.id);
      if (idx === -1) return [...prev, transfer];
      const next = [...prev];
      next[idx] = transfer;
      return next;
    });
  }, []);

  const loadDir = useCallback(
    async (path: string, client?: SftpClient) => {
      const active = client ?? clientRef.current;
      if (!active) return;
      setLoading(true);
      setNotice(null);
      try {
        const result = await active.list(path);
        setCwd(result.path ?? path);
        setEntries(result.entries ?? []);
      } catch (err) {
        setNotice(
          err instanceof SftpOpError
            ? `Could not open folder: ${err.message}`
            : "Could not open folder.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Connect on mount; tear down on unmount.
  useEffect(() => {
    let cancelled = false;

    const client = new SftpClient({
      onStatus: (status) => {
        if (!cancelled) useSftpStore.getState().setConnectionStatus(session.id, status);
      },
      onFatal: (raw) => {
        if (!cancelled) setError(resolveError(raw, session.deviceUid));
      },
    });
    clientRef.current = client;

    void (async () => {
      try {
        await client.connect({
          deviceUid: session.deviceUid,
          username: session.username,
          password: session.password,
          fingerprint: session.fingerprint,
          privateKey: session.privateKey,
          passphrase: session.passphrase,
        });
        // Key material is no longer needed once the challenge is answered.
        useSftpStore.getState().clearSensitiveData(session.id);
        if (cancelled) return;
        await loadDir(".", client);
      } catch {
        // onFatal already sets a specific error for backend failures; this covers transport/POST failures.
        if (!cancelled) setError((prev) => prev ?? HTTP_CONNECT_ERROR);
      }
    })();

    return () => {
      cancelled = true;
      client.close();
      clientRef.current = null;
      useSftpStore.getState().clearSensitiveData(session.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const refresh = useCallback(() => void loadDir(cwd || "."), [cwd, loadDir]);

  const handleOpenDir = useCallback(
    (entry: FileEntry) => void loadDir(entry.path),
    [loadDir],
  );

  const handleNavigate = useCallback(
    (path: string) => void loadDir(path),
    [loadDir],
  );

  const handleNewFolder = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    const name = window.prompt("New folder name");
    if (!name) return;
    void client
      .mkdir(joinPath(cwd, name.trim()))
      .then(() => loadDir(cwd))
      .catch((err: unknown) =>
        setNotice(
          err instanceof SftpOpError
            ? `Could not create folder: ${err.message}`
            : "Could not create folder.",
        ),
      );
  }, [cwd, loadDir]);

  const handleRename = useCallback(
    (entry: FileEntry) => {
      const client = clientRef.current;
      if (!client) return;
      const name = window.prompt("Rename to", entry.name);
      if (!name || name === entry.name) return;
      void client
        .rename(entry.path, joinPath(dirName(entry.path), name.trim()))
        .then(() => loadDir(cwd))
        .catch((err: unknown) =>
          setNotice(
            err instanceof SftpOpError
              ? `Could not rename: ${err.message}`
              : "Could not rename.",
          ),
        );
    },
    [cwd, loadDir],
  );

  const handleDelete = useCallback(
    (entry: FileEntry) => {
      const client = clientRef.current;
      if (!client) return;
      if (!window.confirm(`Delete "${entry.name}"?${entry.isDir ? " This removes its contents." : ""}`)) {
        return;
      }
      void client
        .remove(entry.path, entry.isDir)
        .then(() => loadDir(cwd))
        .catch((err: unknown) =>
          setNotice(
            err instanceof SftpOpError
              ? `Could not delete: ${err.message}`
              : "Could not delete.",
          ),
        );
    },
    [cwd, loadDir],
  );

  const handleDownload = useCallback((entry: FileEntry) => {
    const client = clientRef.current;
    if (!client) return;
    const id = generateRandomUUID();
    upsertTransfer({
      id,
      name: entry.name,
      direction: "download",
      transferred: 0,
      total: entry.size,
      status: "active",
    });
    void client
      .download(entry.path, (progress: SftpProgress) =>
        upsertTransfer({
          id,
          name: entry.name,
          direction: "download",
          transferred: progress.transferred,
          total: progress.total || entry.size,
          status: "active",
        }),
      )
      .then(({ blob, name }) => {
        saveBlob(blob, name);
        upsertTransfer({
          id,
          name: entry.name,
          direction: "download",
          transferred: blob.size,
          total: blob.size,
          status: "done",
        });
      })
      .catch((err: unknown) =>
        upsertTransfer({
          id,
          name: entry.name,
          direction: "download",
          transferred: 0,
          total: entry.size,
          status: "error",
          error: err instanceof Error ? err.message : "download failed",
        }),
      );
  }, [upsertTransfer]);

  const handleFiles = useCallback(
    (files: File[]) => {
      const client = clientRef.current;
      if (!client) return;
      for (const file of files) {
        const id = generateRandomUUID();
        upsertTransfer({
          id,
          name: file.name,
          direction: "upload",
          transferred: 0,
          total: file.size,
          status: "active",
        });
        void client
          .upload(joinPath(cwd, file.name), file, (progress: SftpProgress) =>
            upsertTransfer({
              id,
              name: file.name,
              direction: "upload",
              transferred: progress.transferred,
              total: progress.total || file.size,
              status: "active",
            }),
          )
          .then(() => {
            upsertTransfer({
              id,
              name: file.name,
              direction: "upload",
              transferred: file.size,
              total: file.size,
              status: "done",
            });
            void loadDir(cwd);
          })
          .catch((err: unknown) =>
            upsertTransfer({
              id,
              name: file.name,
              direction: "upload",
              transferred: 0,
              total: file.size,
              status: "error",
              error: err instanceof Error ? err.message : "upload failed",
            }),
          );
      }
    },
    [cwd, loadDir, upsertTransfer],
  );

  const onInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? Array.from(event.target.files) : [];
      if (files.length > 0) handleFiles(files);
      event.target.value = "";
    },
    [handleFiles],
  );

  const dismissTransfer = useCallback(
    (id: string) => setTransfers((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  const handleReconnect = useCallback(() => {
    const store = useSftpStore.getState();
    store.close(session.id);
    store.requestConnect(session.deviceUid, session.deviceName);
  }, [session.id, session.deviceUid, session.deviceName]);

  const status = session.connectionStatus;
  const isConnected = status === "connected";

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Window header */}
      <div className="flex items-center justify-between h-11 px-3 border-b border-border bg-surface shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <FolderOpenIcon className="w-4 h-4 text-primary shrink-0" />
          <span
            className={`shrink-0 w-2 h-2 rounded-full transition-colors duration-300 ${
              isConnected
                ? "bg-accent-green shadow-[0_0_6px_rgba(130,165,104,0.6)]"
                : status === "connecting"
                  ? "bg-accent-yellow animate-pulse"
                  : "bg-accent-red"
            }`}
          />
          <span className="text-[13px] font-mono text-text-secondary truncate">
            {isConnected
              ? `${session.username}@${session.deviceName}`
              : status === "connecting"
                ? `Connecting to ${session.deviceName}...`
                : `${session.deviceName} — Disconnected`}
          </span>
        </div>
        <div className="flex items-center gap-2 ml-1.5 group/lights">
          <button
            type="button"
            onClick={() => close(session.id)}
            className="w-3.5 h-3.5 rounded-full bg-[#ff5f57] border border-[#e0443e] flex items-center justify-center transition-all hover:brightness-110 active:brightness-90"
            title="Close"
          >
            <XMarkIcon
              className="w-2 h-2 text-[#4a0002] opacity-0 group-hover/lights:opacity-100 transition-opacity"
              strokeWidth={3}
            />
          </button>
          <button
            type="button"
            onClick={() => minimize(session.id)}
            className="w-3.5 h-3.5 rounded-full bg-[#febc2e] border border-[#dea123] flex items-center justify-center transition-all hover:brightness-110 active:brightness-90"
            title="Minimize"
          >
            <MinusIcon
              className="w-2 h-2 text-[#5a3b00] opacity-0 group-hover/lights:opacity-100 transition-opacity"
              strokeWidth={3}
            />
          </button>
          <button
            type="button"
            onClick={() => toggleFullscreen(session.id)}
            className="w-3.5 h-3.5 rounded-full bg-[#28c840] border border-[#1aab29] flex items-center justify-center transition-all hover:brightness-110 active:brightness-90"
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? (
              <ArrowsPointingInIcon className="w-2 h-2 text-[#006500] opacity-0 group-hover/lights:opacity-100 transition-opacity" />
            ) : (
              <ArrowsPointingOutIcon className="w-2 h-2 text-[#006500] opacity-0 group-hover/lights:opacity-100 transition-opacity" />
            )}
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 h-11 px-3 border-b border-border bg-card shrink-0">
        <Breadcrumb path={cwd} onNavigate={handleNavigate} />
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            onClick={handleNewFolder}
            disabled={!isConnected}
            icon={<FolderPlusIcon className="w-4 h-4" />}
          >
            New Folder
          </Button>
          <Button
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={!isConnected}
            icon={<ArrowUpTrayIcon className="w-4 h-4" />}
          >
            Upload
          </Button>
          <IconButton
            aria-label="Refresh"
            title="Refresh"
            onClick={refresh}
            disabled={!isConnected}
          >
            <ArrowPathIcon className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 px-3 py-2 bg-accent-red/[0.08] border-b border-accent-red/25 text-xs text-accent-red">
          <ExclamationCircleIcon className="w-4 h-4 shrink-0" />
          <span className="flex-1 truncate">{notice}</span>
          <IconButton size="sm" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <XMarkIcon className="w-3.5 h-3.5" />
          </IconButton>
        </div>
      )}

      {/* Content */}
      <div className="relative flex-1 min-h-0">
        <UploadDropzone onFiles={handleFiles} disabled={!isConnected}>
          <div className="h-full overflow-y-auto">
            <FileTable
              entries={entries}
              loading={loading}
              onOpenDir={handleOpenDir}
              onDownload={handleDownload}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          </div>
        </UploadDropzone>

        <div className="absolute bottom-3 right-3 w-72 max-w-[calc(100%-1.5rem)] z-10">
          <TransferList transfers={transfers} onDismiss={dismissTransfer} />
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onInputChange}
      />

      {error && (
        <SftpErrorBanner
          error={error}
          onReconnect={error.reconnect ? handleReconnect : undefined}
          onClose={() => close(session.id)}
        />
      )}
    </div>
  );
}
