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
import { SftpClient, SftpOpError, type DownloadSink } from "@/api/sftpClient";
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

/** Files at or above this size stream straight to disk (via a save dialog) instead of buffering in memory. */
const STREAM_TO_DISK_THRESHOLD = 256 * 1024 * 1024;

/** Shown when a healthy session drops unexpectedly, with a reconnect affordance. */
const SFTP_DISCONNECT_ERROR: TerminalError = {
  title: "Connection lost",
  message: "The connection to the device was interrupted.",
  reconnect: true,
  hints: [
    "The device may have gone offline or the network dropped. Reconnect to continue browsing.",
  ],
  links: [],
};

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

function isCanceled(err: unknown): boolean {
  return err instanceof SftpOpError && err.code === "canceled";
}

// Minimal shapes for the File System Access API (not in the default TS DOM lib).
interface FileSystemWritableLike {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableLike>;
}

/**
 * Returns a sink that streams download bytes straight to a file the user picks, so large files never have to be held
 * in memory. Returns undefined when the browser lacks the File System Access API (caller falls back to a Blob).
 * Throws (AbortError) when the user dismisses the save dialog.
 */
async function createFileSink(
  suggestedName: string,
): Promise<DownloadSink | undefined> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string;
      }) => Promise<FileSystemFileHandleLike>;
    }
  ).showSaveFilePicker;
  if (!picker) return undefined;

  const handle = await picker({ suggestedName });
  const writable = await handle.createWritable();
  return {
    write: (chunk) => writable.write(chunk),
    close: () => writable.close(),
    abort: () => {
      void writable.abort?.().catch(() => undefined);
    },
  };
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

  // Latest cwd for async completion callbacks, so an operation finishing after the user has navigated away does not
  // reload (and snap back to) the directory it started in.
  const cwdRef = useRef(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  // AbortControllers for in-flight transfers, keyed by their UI transfer id, so a transfer can be cancelled.
  const transferControllers = useRef(new Map<string, AbortController>());

  const { minimize, toggleFullscreen, close } = useSftpStore();
  const isFullscreen = session.state === "fullscreen";

  const addTransfer = useCallback((transfer: SftpTransfer) => {
    setTransfers((prev) => [...prev, transfer]);
  }, []);

  // Patch an existing transfer only — never resurrect one the user has dismissed.
  const patchTransfer = useCallback(
    (id: string, patch: Partial<SftpTransfer>) => {
      setTransfers((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
    },
    [],
  );

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
    // Stable across the component's life (the ref holds one Map), captured for use in the cleanup below.
    const controllers = transferControllers.current;

    const client = new SftpClient({
      onStatus: (status) => {
        if (!cancelled) useSftpStore.getState().setConnectionStatus(session.id, status);
      },
      onFatal: (raw) => {
        if (!cancelled) setError(resolveError(raw, session.deviceUid));
      },
      onClose: () => {
        // Unexpected mid-session drop: surface a reconnectable banner (a clean close() never fires this).
        if (!cancelled) setError((prev) => prev ?? SFTP_DISCONNECT_ERROR);
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
      // Abort any in-flight transfers so their loops/streams stop, then tear down the socket.
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
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
    const targetDir = cwd;
    void client
      .mkdir(joinPath(targetDir, name.trim()))
      .then(() => {
        if (cwdRef.current === targetDir) void loadDir(targetDir);
      })
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
      const targetDir = cwd;
      void client
        .rename(entry.path, joinPath(dirName(entry.path), name.trim()))
        .then(() => {
          if (cwdRef.current === targetDir) void loadDir(targetDir);
        })
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
      const targetDir = cwd;
      void client
        .remove(entry.path, entry.isDir)
        .then(() => {
          if (cwdRef.current === targetDir) void loadDir(targetDir);
        })
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

  const handleDownload = useCallback(
    (entry: FileEntry) => {
      const client = clientRef.current;
      if (!client) return;
      const id = generateRandomUUID();
      const controller = new AbortController();
      transferControllers.current.set(id, controller);
      addTransfer({
        id,
        name: entry.name,
        direction: "download",
        transferred: 0,
        total: entry.size,
        status: "active",
      });

      void (async () => {
        // Stream large files straight to disk so the tab does not have to buffer the whole file in memory.
        let sink: DownloadSink | undefined;
        if (entry.size >= STREAM_TO_DISK_THRESHOLD) {
          try {
            sink = await createFileSink(entry.name);
          } catch {
            // User dismissed the save dialog — cancel the download entirely.
            controller.abort();
            transferControllers.current.delete(id);
            setTransfers((prev) => prev.filter((t) => t.id !== id));
            return;
          }
        }

        try {
          const { blob, name } = await client.download(entry.path, {
            signal: controller.signal,
            sink,
            onProgress: (progress: SftpProgress) =>
              patchTransfer(id, {
                transferred: progress.transferred,
                total: progress.total || entry.size,
              }),
          });
          if (blob) saveBlob(blob, name);
          patchTransfer(id, {
            transferred: entry.size,
            total: entry.size,
            status: "done",
          });
        } catch (err) {
          if (isCanceled(err)) {
            setTransfers((prev) => prev.filter((t) => t.id !== id));
          } else {
            patchTransfer(id, {
              status: "error",
              error: err instanceof Error ? err.message : "download failed",
            });
          }
        } finally {
          transferControllers.current.delete(id);
        }
      })();
    },
    [addTransfer, patchTransfer],
  );

  const handleFiles = useCallback(
    (files: File[]) => {
      const client = clientRef.current;
      if (!client) return;
      const targetDir = cwd;
      for (const file of files) {
        // Confirm before clobbering an existing file of the same name.
        const clashes = entries.some((e) => !e.isDir && e.name === file.name);
        if (clashes && !window.confirm(`"${file.name}" already exists here. Replace it?`)) {
          continue;
        }

        const id = generateRandomUUID();
        const controller = new AbortController();
        transferControllers.current.set(id, controller);
        addTransfer({
          id,
          name: file.name,
          direction: "upload",
          transferred: 0,
          total: file.size,
          status: "active",
        });
        void client
          .upload(joinPath(targetDir, file.name), file, {
            signal: controller.signal,
            onProgress: (progress: SftpProgress) =>
              patchTransfer(id, {
                transferred: progress.transferred,
                total: progress.total || file.size,
              }),
          })
          .then(() => {
            patchTransfer(id, {
              transferred: file.size,
              total: file.size,
              status: "done",
            });
            if (cwdRef.current === targetDir) void loadDir(targetDir);
          })
          .catch((err: unknown) => {
            if (isCanceled(err)) {
              setTransfers((prev) => prev.filter((t) => t.id !== id));
            } else {
              patchTransfer(id, {
                status: "error",
                error: err instanceof Error ? err.message : "upload failed",
              });
            }
          })
          .finally(() => transferControllers.current.delete(id));
      }
    },
    [cwd, entries, loadDir, addTransfer, patchTransfer],
  );

  const onInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? Array.from(event.target.files) : [];
      if (files.length > 0) handleFiles(files);
      event.target.value = "";
    },
    [handleFiles],
  );

  const dismissTransfer = useCallback((id: string) => {
    // Cancelling an active transfer aborts it (uploads stop sending and the server drops the temp file; downloads
    // stop saving). Finished rows are simply removed.
    const controller = transferControllers.current.get(id);
    if (controller) {
      controller.abort();
      transferControllers.current.delete(id);
    }
    setTransfers((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleReconnect = useCallback(() => {
    const store = useSftpStore.getState();
    store.close(session.id);
    store.requestConnect(session.deviceUid, session.deviceName);
  }, [session.id, session.deviceUid, session.deviceName]);

  const status = session.connectionStatus;
  const isConnected = status === "connected";
  // A download blocks the gateway's single-threaded dispatch loop, so other operations would silently queue behind
  // it. Pause interactions while one is active and tell the user why, instead of appearing frozen.
  const downloading = transfers.some(
    (t) => t.direction === "download" && t.status === "active",
  );
  const canInteract = isConnected && !downloading;

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
        <Breadcrumb path={cwd} onNavigate={canInteract ? handleNavigate : () => undefined} />
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            onClick={handleNewFolder}
            disabled={!canInteract}
            icon={<FolderPlusIcon className="w-4 h-4" />}
          >
            New Folder
          </Button>
          <Button
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canInteract}
            icon={<ArrowUpTrayIcon className="w-4 h-4" />}
          >
            Upload
          </Button>
          <IconButton
            aria-label="Refresh"
            title="Refresh"
            onClick={refresh}
            disabled={!canInteract}
          >
            <ArrowPathIcon className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      {downloading && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/[0.06] border-b border-primary/20 text-xs text-text-secondary">
          <ArrowPathIcon className="w-3.5 h-3.5 shrink-0 animate-spin" />
          <span className="flex-1 truncate">
            Downloading… other actions are paused until the transfer finishes.
          </span>
        </div>
      )}

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
        <UploadDropzone onFiles={handleFiles} disabled={!canInteract}>
          <div className="h-full overflow-y-auto">
            <FileTable
              entries={entries}
              loading={loading}
              disabled={downloading}
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
