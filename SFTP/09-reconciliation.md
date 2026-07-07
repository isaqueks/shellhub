# Reconciliation & Code-Verified Corrections

**This document is authoritative.** When any other doc in this set is ambiguous or
conflicts with another, the decision here wins. Each entry was flagged by a doc author as
underspecified, then resolved against the **real source code** (with citations). Fold these
into the individual docs as they are implemented.

## Scope / non-goals

Resolutions only — no new feature scope. Every item traces to a concrete file:line in the
ShellHub repo verified after the doc set was drafted.

---

## 1. Protocol & message-encoding decisions

| # | Question (source doc) | Decision | Basis |
|---|-----------------------|----------|-------|
| P1 | `messageKind` const-block form (`02`, `03`) | **The numeric values 6–18 are what is locked, not the block form.** Either continue the existing `iota + 1` block, or open a new block starting at `iota + 6` (as `02-protocol.md` sketches) — both compile to the same 6–18. Pick one and keep the two docs' code sketches identical. | `ssh/web/messages.go:5-20` |
| P2 | `messageKindSftpError.code` values (`03`) | Lock a **small enum**, mapped from Go errors, **not** the op name: `"not_found"`, `"permission_denied"`, `"not_dir"`, `"is_dir"`, `"exists"`, `"unsupported"`, `"io"` (fallback), `"protocol"` (malformed client message). Map via `errors.Is(err, os.ErrNotExist)`, `os.ErrPermission`, `fs.ErrExist`, and `*sftp.StatusError` codes. | `pkg/sftp` returns `*sftp.StatusError`; `os`/`io/fs` sentinels |
| P3 | Download vs upload/metadata concurrency (`02`, `04`) | **Downloads are serialized — at most one in flight per WebSocket** (binary frames are untagged, cf. `Conn.WriteBinary` at `ssh/web/conn.go:132`). Metadata ops (list/stat/mkdir/rename/remove) and **uploads** are self-describing JSON with a `requestId` and MAY run concurrently. The frontend client enforces a single-download queue only. | `ssh/web/conn.go:132-152` |
| P4 | `messageKindSftpProgress` cadence (`02`, `07`) | Emit progress **after each 32 KiB binary frame (download) / after each chunk write (upload)**. A final 100% progress is optional; completion is signalled by `messageKindSftpDownloadEnd` / `messageKindSftpResult{op:"upload"}`. | design decision, locked |
| P5 | `messageKindSftpDownloadBegin` shape (`02`, `04`) | Intentionally a **subset** of `FileEntry`: `{requestId, name, size, mode, mtime}` only. The frontend must not expect `path`/`modeBits`/`isDir`/`isLink` there. | canonical spec §3.1 |
| P6 | `messageKindSftpProgress` has no filename (`04`) | Correct and intentional — it carries only `requestId`. `TransferList` maps `requestId → filename` client-side from the originating `download`/`upload` call. | canonical spec §3.1 |

---

## 2. Backend decisions

| # | Question (source doc) | Decision | Basis |
|---|-----------------------|----------|-------|
| B1 | `NewSFTPServerBridge` registration site (`03`) | Wire it in **`ssh/main.go:74`**, immediately after the existing `web.NewSSHServerBridge(router, cache)` call, with the same `(router, cache)` arguments. | `ssh/main.go:74` |
| B2 | SSH session variable name (`01`, `03`) | In `newSftpSession`, name the `*ssh.Session` **`sftpSess`** (the existing `newSession` confusingly names it `agent` at `ssh/web/session.go:217`). Code sketches call `sftpSess.RequestSubsystem("sftp")`. | `ssh/web/session.go:217` |
| B3 | `stderr` pipe (`01`) | `newSftpSession` needs **only `StdinPipe`/`StdoutPipe`**. Drop the `StderrPipe` + `io.Copy(conn, stderr)` that `newSession` uses (`session.go:240,301`) — SFTP has no stderr relay. | `ssh/web/session.go:240,301` |
| B4 | Error sentinels, exact set (`03`) | Canonical set in `ssh/web/errors.go`: **`ErrSubsystem`, `ErrSftpClient`, `ErrSftpOpen`, `ErrSftpOp`** (supersedes the shorter list in the canonical spec §4). | canonical spec §4 (corrected) |
| B5 | Upload progress `total` source (`03`) | The dispatch loop keeps a **per-upload state struct** keyed by `requestId`: `type uploadState struct { file *sftp.File; path string; size int64; written int64 }` — **not** a bare `map[string]*sftp.File`. `total` comes from the `messageKindSftpUpload` begin message's `size`. | design decision, locked |
| B6 | Initial working directory (`04`) | The agent `chdir`s to the OS user's `HOME` before serving (`agent/sftp.go` `syscall.Chdir(home)`), so a relative `"."` resolves to `HOME`. The client resolves the start dir via the SFTP client's `Getwd()` (realpath of `"."`) and lists from there. | `agent/sftp.go:77` (`syscall.Chdir(home)`) |

---

## 3. Frontend decisions

| # | Question (source doc) | Decision | Basis |
|---|-----------------------|----------|-------|
| F1 | `parseMessage` reuse (`02`, `04`) | `terminalErrors.ts` `parseMessage` hard-requires `typeof data === "string"` (`terminalErrors.ts:150-172`) and **cannot** parse object payloads (RESULT/PROGRESS/DOWNLOAD_BEGIN). Add a **new `parseEnvelope` helper** in `components/sftp/sftpProtocol.ts`. Only the `WS_KIND` SIGNATURE/ERROR/SESSION **constants** are reused, not the parser. | `ui/.../terminal/terminalErrors.ts:150-172` |
| F2 | Connector-mode gating field (`04`, `06`) | `DeviceInfo` (`pkg/models/device.go:87-93`) has **no** host/connector flag. Connector devices are **containers** with their own UI surface (`ui/.../pages/containers/`, `AddDockerConnectorDrawer.tsx`). **Decision:** expose "Browse Files" only on **host-device surfaces** (`pages/devices/`, `DeviceDetails.tsx`) and **not** on containers; additionally handle the server error `"SFTP isn't supported to ShellHub Agent in connector mode"` gracefully as a backstop. No new model field required. (Optional future: add a `mode` field to `DeviceInfo`.) | `pkg/models/device.go:87-93`; `agent/server/modes/connector/sessioner.go:210-211` |
| F3 | Cross-manager window z-index (`04`) | Terminal and SFTP windows both render at `z-40` via **per-store** `demoteOthers`, so same-page opens can overlap. **Deferred to M5:** unify with a shared window registry or give SFTP a distinct z-index band. Acceptable for M1–M4. | `ui/.../terminal/TerminalManager.tsx` (per-store state) |

---

## 4. Risk fact-check

| # | Claim | Verified fact | Basis |
|---|-------|---------------|-------|
| R1 | Exec-close truncation version boundary | The inline comment says "less than v0.9.2" but the **actual condition** is `ver.LessThan(semver.MustParse("v0.9.3")) && sess.Type == ExecRequestType` → `agent.Close()` instead of `CloseWrite()`. A follow-up note in the code confirms the intent: "We indicate here v0.9.3, but it is not included due the assertion `less than`." So the truncation risk applies to agents **< 0.9.3** on exec-typed (subsystem) sessions. Use `< 0.9.3` everywhere. | `ssh/server/channels/utils.go:128-138` |
| R2 | Connector SFTP unsupported | Confirmed: `func (s *Sessioner) SFTP(_ gliderssh.Session) error { return errors.New("SFTP isn't supported to ShellHub Agent in connector mode") }`. | `agent/server/modes/connector/sessioner.go:210-211` |
| R3 | Gateway forwards subsystem + starts pipe | Confirmed transparent forwarding; the shared `case ExecRequestType, SubsystemRequestType` sets `sess.Type = ExecRequestType` at `ssh/server/channels/session.go:282`. First-class SFTP type (M5) splits this case. | `ssh/server/channels/session.go:282` |

---

## 5. Summary of what changed vs the drafted docs

- **02-protocol.md** — adopt the P2 error-code enum, P3 concurrency rule, P4 progress cadence.
- **03-backend.md** — use B1 (`ssh/main.go:74`), B2 (`sftpSess`), B4 error set, B5 upload-state struct.
- **04-frontend.md** — use F1 (`parseEnvelope`), F2 (containers-vs-devices gating), B6 (`Getwd` start dir).
- **08-risks-and-open-questions.md** — correct the version boundary to **< 0.9.3** (R1).

Everything else in the drafted docs stands as written.
