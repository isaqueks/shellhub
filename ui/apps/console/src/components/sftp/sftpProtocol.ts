// Wire protocol for the Web SFTP bridge. Mirrors ssh/web/messages.go (messageKind) and the payload structs in
// ssh/web/sftp.go. Kinds 3/4/5 are shared with the terminal bridge (see components/terminal/terminalErrors.ts).

export type SftpConnectionStatus = "connecting" | "connected" | "disconnected";

export const SFTP_KIND = {
  // Shared with the terminal bridge.
  SIGNATURE: 3,
  ERROR: 4,
  SESSION: 5,
  // Client -> server requests (each carries a requestId).
  LIST: 6,
  STAT: 7,
  MKDIR: 8,
  RENAME: 9,
  REMOVE: 10,
  DOWNLOAD: 11,
  UPLOAD: 12,
  UPLOAD_CHUNK: 13,
  // Server -> client responses.
  RESULT: 14,
  DOWNLOAD_BEGIN: 15,
  DOWNLOAD_END: 16,
  PROGRESS: 17,
  SFTP_ERROR: 18,
} as const;

export type SftpOp = "list" | "stat" | "mkdir" | "rename" | "remove" | "upload";

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  /** Symbolic mode, e.g. "drwxr-xr-x". */
  mode: string;
  modeBits: number;
  /** Modification time, unix seconds. */
  mtime: number;
  isDir: boolean;
  isLink: boolean;
  linkTarget?: string;
}

export interface SftpResult {
  requestId: string;
  op: SftpOp;
  ok: boolean;
  /** Resolved directory (set for "list"). */
  path?: string;
  entries?: FileEntry[];
  stat?: FileEntry;
}

export interface SftpDownloadBegin {
  requestId: string;
  name: string;
  size: number;
  mode: string;
  mtime: number;
}

export interface SftpProgress {
  requestId: string;
  transferred: number;
  total: number;
  direction: "download" | "upload";
}

export interface SftpErrorMessage {
  requestId?: string;
  code: string;
  message: string;
}

export interface Envelope {
  kind: number;
  data: unknown;
}

/** UI-side model of an in-flight or finished transfer, rendered by TransferList. */
export interface SftpTransfer {
  id: string;
  name: string;
  direction: "upload" | "download";
  transferred: number;
  total: number;
  status: "active" | "done" | "error";
  error?: string;
}

/**
 * Parse a JSON text frame into a {kind, data} envelope. Unlike the terminal's parseMessage, `data` may be any JSON
 * value (object payloads for SFTP results, or a string for SIGNATURE/ERROR/SESSION).
 */
export function parseEnvelope(raw: string): Envelope | null {
  try {
    const msg: unknown = JSON.parse(raw);
    if (
      typeof msg === "object" &&
      msg !== null &&
      "kind" in msg &&
      typeof msg.kind === "number"
    ) {
      const record = msg as { kind: number; data?: unknown };
      return { kind: record.kind, data: record.data };
    }
  } catch {
    // Not JSON — ignore.
  }
  return null;
}

/** Human-readable, sortable size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
