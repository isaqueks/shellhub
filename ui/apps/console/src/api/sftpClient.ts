import { Buffer } from "buffer";
import apiClient from "@/api/client";
import { generateSignature } from "@/utils/sshKeys";
import {
  SFTP_KIND,
  parseEnvelope,
  type FileEntry,
  type SftpResult,
  type SftpProgress,
  type SftpDownloadBegin,
  type SftpErrorMessage,
  type SftpConnectionStatus,
} from "@/components/sftp/sftpProtocol";

/** Raw upload chunk size before base64 (fits the gateway's 256 KiB SftpReadMessageBufferSize after expansion). */
const UPLOAD_CHUNK_SIZE = 128 * 1024;
/** Pause sending upload chunks while the socket's send buffer is above this, to bound memory on large uploads. */
const UPLOAD_BACKPRESSURE = 8 * 1024 * 1024;

export interface SftpCredentials {
  deviceUid: string;
  username: string;
  password?: string;
  fingerprint?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SftpClientCallbacks {
  onStatus?: (status: SftpConnectionStatus) => void;
  /** Fatal connection/auth error (maps to the shared errorMap message string). */
  onFatal?: (raw: string) => void;
  onSessionUid?: (uid: string) => void;
}

interface Pending {
  resolve: (result: SftpResult) => void;
  reject: (error: Error) => void;
}

interface ActiveDownload {
  requestId: string;
  parts: ArrayBuffer[];
  meta?: SftpDownloadBegin;
  onProgress?: (progress: SftpProgress) => void;
  resolve: (file: { blob: Blob; name: string }) => void;
  reject: (error: Error) => void;
}

/** An error raised by a per-operation SFTP failure, carrying the backend code. */
export class SftpOpError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "SftpOpError";
    this.code = code;
  }
}

/**
 * SftpClient bridges the browser to a device's SFTP filesystem over the /ws/sftp WebSocket. It exposes a promise-based
 * file API (list/stat/mkdir/rename/remove/download/upload); requests are correlated by a generated requestId. Only one
 * download runs at a time because download bytes arrive as untagged binary frames.
 */
export class SftpClient {
  private ws: WebSocket | null = null;
  private readonly callbacks: SftpClientCallbacks;
  private readonly pending = new Map<string, Pending>();
  private readonly uploadProgress = new Map<string, (progress: SftpProgress) => void>();
  private activeDownload: ActiveDownload | null = null;
  private downloadLock: Promise<unknown> = Promise.resolve();
  private keyMaterial?: string;
  private keyPassphrase?: string;
  private nextId = 0;

  private ready!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private isReady = false;

  constructor(callbacks: SftpClientCallbacks = {}) {
    this.callbacks = callbacks;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /** Opens the WebSocket and resolves once the server signals it is authenticated and ready (SESSION message). */
  async connect(creds: SftpCredentials): Promise<void> {
    this.callbacks.onStatus?.("connecting");

    const body: Record<string, string> = {
      device: creds.deviceUid,
      username: creds.username,
    };
    if (creds.fingerprint) {
      body.fingerprint = creds.fingerprint;
    } else {
      body.password = creds.password ?? "";
    }

    const res = await apiClient.post<{ token: string }>("/ws/sftp", body);
    const token = res.data.token;

    // Held only until the signature challenge is answered, then wiped.
    this.keyMaterial = creds.privateKey;
    this.keyPassphrase = creds.passphrase;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/sftp?token=${token}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (event) => this.handleMessage(event);
    ws.onclose = () => {
      this.callbacks.onStatus?.("disconnected");
      this.failAll(new Error("connection closed"));
    };
    ws.onerror = () => {
      this.callbacks.onStatus?.("disconnected");
      this.rejectReady(new Error("network error"));
    };

    await this.ready;
    this.isReady = true;
    this.callbacks.onStatus?.("connected");
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
    this.failAll(new Error("closed"));
  }

  // --- File operations -------------------------------------------------------

  list(path: string): Promise<SftpResult> {
    return this.request(SFTP_KIND.LIST, { path });
  }

  stat(path: string): Promise<SftpResult> {
    return this.request(SFTP_KIND.STAT, { path });
  }

  mkdir(path: string): Promise<SftpResult> {
    return this.request(SFTP_KIND.MKDIR, { path });
  }

  rename(from: string, to: string): Promise<SftpResult> {
    return this.request(SFTP_KIND.RENAME, { from, to });
  }

  remove(path: string, recursive: boolean): Promise<SftpResult> {
    return this.request(SFTP_KIND.REMOVE, { path, recursive });
  }

  /** Downloads a file. Serialized: concurrent calls run one after another. */
  download(
    path: string,
    onProgress?: (progress: SftpProgress) => void,
  ): Promise<{ blob: Blob; name: string }> {
    const run = () => this.doDownload(path, onProgress);
    const result = this.downloadLock.then(run, run);
    // Release the lock after this download settles, regardless of outcome.
    this.downloadLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private doDownload(
    path: string,
    onProgress?: (progress: SftpProgress) => void,
  ): Promise<{ blob: Blob; name: string }> {
    return new Promise((resolve, reject) => {
      const requestId = this.id();
      this.activeDownload = { requestId, parts: [], onProgress, resolve, reject };
      this.send(SFTP_KIND.DOWNLOAD, { requestId, path });
    });
  }

  /** Uploads a File to the given remote path, overwriting it. */
  async upload(
    path: string,
    file: File,
    onProgress?: (progress: SftpProgress) => void,
  ): Promise<void> {
    const requestId = this.id();
    const done = new Promise<SftpResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    if (onProgress) this.uploadProgress.set(requestId, onProgress);

    this.send(SFTP_KIND.UPLOAD, { requestId, path, size: file.size });

    try {
      for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_SIZE) {
        const end = Math.min(offset + UPLOAD_CHUNK_SIZE, file.size);
        const buffer = await file.slice(offset, end).arrayBuffer();
        const eof = end >= file.size;
        this.send(SFTP_KIND.UPLOAD_CHUNK, {
          requestId,
          data: arrayBufferToBase64(buffer),
          eof,
        });
        await this.drain();
      }

      // Zero-byte file: no chunk ran above, so send a terminal empty chunk.
      if (file.size === 0) {
        this.send(SFTP_KIND.UPLOAD_CHUNK, { requestId, data: "", eof: true });
      }

      await done;
    } finally {
      this.uploadProgress.delete(requestId);
    }
  }

  // --- Internals -------------------------------------------------------------

  private request(kind: number, extra: Record<string, unknown>): Promise<SftpResult> {
    return new Promise<SftpResult>((resolve, reject) => {
      const requestId = this.id();
      this.pending.set(requestId, { resolve, reject });
      this.send(kind, { requestId, ...extra });
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      // Binary frame = a slice of the active download.
      if (this.activeDownload) this.activeDownload.parts.push(event.data);
      return;
    }

    const envelope = parseEnvelope(String(event.data as unknown));
    if (!envelope) return;

    switch (envelope.kind) {
      case SFTP_KIND.SIGNATURE:
        this.handleSignature(envelope.data as string);
        break;
      case SFTP_KIND.ERROR: {
        const raw = String(envelope.data);
        this.callbacks.onFatal?.(raw);
        this.rejectReady(new Error(raw));
        this.failAll(new Error(raw));
        break;
      }
      case SFTP_KIND.SESSION:
        this.callbacks.onSessionUid?.(String(envelope.data));
        this.resolveReady();
        break;
      case SFTP_KIND.RESULT: {
        const result = envelope.data as SftpResult;
        this.pending.get(result.requestId)?.resolve(result);
        this.pending.delete(result.requestId);
        break;
      }
      case SFTP_KIND.DOWNLOAD_BEGIN: {
        const begin = envelope.data as SftpDownloadBegin;
        if (this.activeDownload && this.activeDownload.requestId === begin.requestId) {
          this.activeDownload.meta = begin;
        }
        break;
      }
      case SFTP_KIND.PROGRESS: {
        const progress = envelope.data as SftpProgress;
        if (progress.direction === "download") {
          this.activeDownload?.onProgress?.(progress);
        } else {
          this.uploadProgress.get(progress.requestId)?.(progress);
        }
        break;
      }
      case SFTP_KIND.DOWNLOAD_END: {
        const requestId = (envelope.data as { requestId: string }).requestId;
        this.finishDownload(requestId);
        break;
      }
      case SFTP_KIND.SFTP_ERROR: {
        const error = envelope.data as SftpErrorMessage;
        this.failRequest(error);
        break;
      }
      default:
        break;
    }
  }

  private handleSignature(challengeB64: string): void {
    const key = this.keyMaterial;
    if (!key) return;
    try {
      const signature = generateSignature(
        key,
        Buffer.from(challengeB64, "base64"),
        this.keyPassphrase,
      );
      this.send(SFTP_KIND.SIGNATURE, signature);
    } catch {
      this.callbacks.onFatal?.("failed to get auth data from key");
      this.rejectReady(new Error("failed to sign challenge"));
    } finally {
      // Wipe key material once used (or on failure).
      this.keyMaterial = undefined;
      this.keyPassphrase = undefined;
    }
  }

  private finishDownload(requestId: string): void {
    const download = this.activeDownload;
    if (!download || download.requestId !== requestId) return;
    this.activeDownload = null;
    const blob = new Blob(download.parts);
    download.resolve({ blob, name: download.meta?.name ?? "download" });
  }

  private failRequest(error: SftpErrorMessage): void {
    const opError = new SftpOpError(error.message, error.code);

    if (this.activeDownload && (!error.requestId || this.activeDownload.requestId === error.requestId)) {
      this.activeDownload.reject(opError);
      this.activeDownload = null;
      return;
    }

    if (error.requestId) {
      this.pending.get(error.requestId)?.reject(opError);
      this.pending.delete(error.requestId);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.activeDownload) {
      this.activeDownload.reject(error);
      this.activeDownload = null;
    }
    if (!this.isReady) this.rejectReady(error);
  }

  private send(kind: number, data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ kind, data }));
    }
  }

  /** Waits until the socket's send buffer drains below the backpressure threshold. */
  private async drain(): Promise<void> {
    while (this.ws && this.ws.bufferedAmount > UPLOAD_BACKPRESSURE) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private id(): string {
    this.nextId += 1;
    return String(this.nextId);
  }
}

/** Base64-encodes an ArrayBuffer without blowing the call stack on large chunks. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export type { FileEntry };
