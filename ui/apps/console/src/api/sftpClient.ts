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
/** A metadata request (list/stat/mkdir/rename/remove) that gets no response within this window is rejected. */
const REQUEST_TIMEOUT = 30_000;
/** A transfer that makes no progress for this long is treated as a dead socket and failed. */
const TRANSFER_STALL_TIMEOUT = 60_000;

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
  /** The socket closed unexpectedly after a healthy session (mid-session disconnect). */
  onClose?: () => void;
  onSessionUid?: (uid: string) => void;
}

/** A destination for streamed download bytes (e.g. the File System Access API). Avoids buffering the whole file. */
export interface DownloadSink {
  write(chunk: ArrayBuffer): void | Promise<void>;
  close(): void | Promise<void>;
  abort(): void;
}

export interface DownloadOptions {
  onProgress?: (progress: SftpProgress) => void;
  signal?: AbortSignal;
  /** When provided, frames are streamed here instead of buffered in memory; the resolved blob is then null. */
  sink?: DownloadSink;
}

export interface UploadOptions {
  onProgress?: (progress: SftpProgress) => void;
  signal?: AbortSignal;
}

interface Pending {
  resolve: (result: SftpResult) => void;
  reject: (error: Error) => void;
}

interface UploadControl {
  aborted: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
}

interface ActiveDownload {
  requestId: string;
  parts: ArrayBuffer[];
  sink: DownloadSink | null;
  writeChain: Promise<void>;
  canceled: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
  meta?: SftpDownloadBegin;
  onProgress?: (progress: SftpProgress) => void;
  resolve: (file: { blob: Blob | null; name: string }) => void;
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
  private readonly uploads = new Map<string, UploadControl>();
  private activeDownload: ActiveDownload | null = null;
  private downloadLock: Promise<unknown> = Promise.resolve();
  private keyMaterial?: string;
  private keyPassphrase?: string;
  private nextId = 0;

  private ready!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private isReady = false;
  /** Set once close() has been called so an in-flight connect() aborts instead of leaking a live socket. */
  private closed = false;

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

    // close() may have run while the POST was in flight (unmount / StrictMode / Reconnect). If so, abort here so we
    // never open — and leave dangling — an authenticated socket that nobody owns.
    if (this.closed) {
      throw new Error("closed");
    }

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
      // A drop after a healthy session is a mid-session disconnect the UI should surface (with reconnect), as long
      // as it wasn't an intentional close().
      if (this.isReady && !this.closed) {
        this.callbacks.onClose?.();
      }
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
    this.closed = true;
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
    opts: DownloadOptions = {},
  ): Promise<{ blob: Blob | null; name: string }> {
    const run = () => this.doDownload(path, opts);
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
    opts: DownloadOptions,
  ): Promise<{ blob: Blob | null; name: string }> {
    return new Promise((resolve, reject) => {
      const requestId = this.id();
      const download: ActiveDownload = {
        requestId,
        parts: [],
        sink: opts.sink ?? null,
        writeChain: Promise.resolve(),
        canceled: false,
        onProgress: opts.onProgress,
        resolve,
        reject,
      };
      this.activeDownload = download;
      this.armDownloadWatchdog(download);

      if (opts.signal) {
        if (opts.signal.aborted) {
          this.cancelDownload(requestId);
        } else {
          opts.signal.addEventListener("abort", () => this.cancelDownload(requestId), {
            once: true,
          });
        }
      }

      this.send(SFTP_KIND.DOWNLOAD, { requestId, path });
    });
  }

  /**
   * Cancels an in-flight download: further bytes are discarded (freeing memory) and nothing is saved. The active
   * slot is kept until the server's DOWNLOAD_END arrives so the download lock is not released early and later frames
   * cannot be misattributed to the next download. The transfer bytes still finish arriving in the background.
   */
  private cancelDownload(requestId: string): void {
    const download = this.activeDownload;
    if (!download || download.requestId !== requestId || download.canceled) return;
    download.canceled = true;
    download.parts = [];
    download.sink?.abort();
  }

  /** Uploads a File to the given remote path, overwriting it atomically on the server. */
  async upload(
    path: string,
    file: File,
    opts: UploadOptions = {},
  ): Promise<void> {
    const requestId = this.id();
    const control: UploadControl = { aborted: false };
    this.uploads.set(requestId, control);

    const done = new Promise<SftpResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    if (opts.onProgress) this.uploadProgress.set(requestId, opts.onProgress);

    const abort = () => {
      if (control.aborted) return;
      control.aborted = true;
      // Tell the gateway to drop the temp file so the destination is left untouched.
      this.send(SFTP_KIND.CANCEL, { requestId });
      const entry = this.pending.get(requestId);
      this.pending.delete(requestId);
      entry?.reject(new SftpOpError("upload canceled", "canceled"));
    };
    const onSignalAbort = () => abort();
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    this.armUploadWatchdog(requestId, control);

    try {
      this.send(SFTP_KIND.UPLOAD, { requestId, path, size: file.size });

      for (let offset = 0; offset < file.size && !control.aborted; offset += UPLOAD_CHUNK_SIZE) {
        const end = Math.min(offset + UPLOAD_CHUNK_SIZE, file.size);
        const buffer = await file.slice(offset, end).arrayBuffer();
        if (control.aborted) break;
        const eof = end >= file.size;
        this.send(SFTP_KIND.UPLOAD_CHUNK, {
          requestId,
          data: arrayBufferToBase64(buffer),
          eof,
        });
        await this.drain(control);
      }

      if (control.aborted) {
        // done was already rejected by abort(); surface it and stop — no more chunks are sent.
        await done;
        return;
      }

      // Zero-byte file: no chunk ran above, so send a terminal empty chunk.
      if (file.size === 0) {
        this.send(SFTP_KIND.UPLOAD_CHUNK, { requestId, data: "", eof: true });
      }

      await done;
    } finally {
      this.clearUploadWatchdog(requestId);
      this.uploads.delete(requestId);
      this.uploadProgress.delete(requestId);
      opts.signal?.removeEventListener("abort", onSignalAbort);
    }
  }

  // --- Internals -------------------------------------------------------------

  private request(kind: number, extra: Record<string, unknown>): Promise<SftpResult> {
    return new Promise<SftpResult>((resolve, reject) => {
      const requestId = this.id();
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          reject(new SftpOpError("operation timed out", "timeout"));
        }
      }, REQUEST_TIMEOUT);
      this.pending.set(requestId, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send(kind, { requestId, ...extra });
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      // Binary frame = a slice of the active download.
      const download = this.activeDownload;
      if (!download) return;
      this.armDownloadWatchdog(download);
      if (download.canceled) return; // discarded, but still awaiting DOWNLOAD_END
      if (download.sink) {
        const chunk = event.data;
        download.writeChain = download.writeChain.then(() => download.sink!.write(chunk));
      } else {
        download.parts.push(event.data);
      }
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
          this.armDownloadWatchdog(this.activeDownload);
        }
        break;
      }
      case SFTP_KIND.PROGRESS: {
        const progress = envelope.data as SftpProgress;
        if (progress.direction === "download") {
          if (this.activeDownload) this.armDownloadWatchdog(this.activeDownload);
          this.activeDownload?.onProgress?.(progress);
        } else {
          const control = this.uploads.get(progress.requestId);
          if (control) this.armUploadWatchdog(progress.requestId, control);
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
    this.clearDownloadWatchdog(download);

    if (download.canceled) {
      download.sink?.abort();
      download.reject(new SftpOpError("download canceled", "canceled"));
      return;
    }

    if (download.sink) {
      const sink = download.sink;
      download.writeChain
        .then(() => sink.close())
        .then(() => download.resolve({ blob: null, name: download.meta?.name ?? "download" }))
        .catch((err: unknown) =>
          download.reject(err instanceof Error ? err : new Error("failed to write download")),
        );
      return;
    }

    const blob = new Blob(download.parts);
    download.resolve({ blob, name: download.meta?.name ?? "download" });
  }

  private failRequest(error: SftpErrorMessage): void {
    const opError = new SftpOpError(error.message, error.code);

    // Only claim the active download when the error explicitly targets it. An id-less error must not steal a
    // healthy download's rejection.
    if (this.activeDownload && error.requestId && this.activeDownload.requestId === error.requestId) {
      const download = this.activeDownload;
      this.activeDownload = null;
      this.clearDownloadWatchdog(download);
      download.sink?.abort();
      download.reject(opError);
      return;
    }

    if (error.requestId) {
      const control = this.uploads.get(error.requestId);
      if (control) control.aborted = true; // stop the chunk loop for this upload
      this.pending.get(error.requestId)?.reject(opError);
      this.pending.delete(error.requestId);
    }
  }

  private failAll(error: Error): void {
    for (const control of this.uploads.values()) {
      control.aborted = true;
      if (control.watchdog) clearTimeout(control.watchdog);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.activeDownload) {
      const download = this.activeDownload;
      this.activeDownload = null;
      this.clearDownloadWatchdog(download);
      download.sink?.abort();
      download.reject(error);
    }
    if (!this.isReady) this.rejectReady(error);
  }

  private send(kind: number, data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ kind, data }));
    }
  }

  /** Waits until the socket's send buffer drains below the backpressure threshold (or the upload is aborted). */
  private async drain(control: UploadControl): Promise<void> {
    while (
      !control.aborted &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.ws.bufferedAmount > UPLOAD_BACKPRESSURE
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private armDownloadWatchdog(download: ActiveDownload): void {
    if (download.watchdog) clearTimeout(download.watchdog);
    download.watchdog = setTimeout(() => {
      if (this.activeDownload !== download) return;
      this.activeDownload = null;
      download.sink?.abort();
      download.reject(new SftpOpError("transfer stalled", "timeout"));
    }, TRANSFER_STALL_TIMEOUT);
  }

  private clearDownloadWatchdog(download: ActiveDownload): void {
    if (download.watchdog) clearTimeout(download.watchdog);
    download.watchdog = undefined;
  }

  private armUploadWatchdog(requestId: string, control: UploadControl): void {
    if (control.watchdog) clearTimeout(control.watchdog);
    control.watchdog = setTimeout(() => {
      if (control.aborted) return;
      control.aborted = true;
      this.send(SFTP_KIND.CANCEL, { requestId });
      const entry = this.pending.get(requestId);
      this.pending.delete(requestId);
      entry?.reject(new SftpOpError("transfer stalled", "timeout"));
    }, TRANSFER_STALL_TIMEOUT);
  }

  private clearUploadWatchdog(requestId: string): void {
    const control = this.uploads.get(requestId);
    if (control?.watchdog) {
      clearTimeout(control.watchdog);
      control.watchdog = undefined;
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
