package web

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"github.com/shellhub-io/shellhub/pkg/cache"
	"github.com/shellhub-io/shellhub/pkg/uuid"
	log "github.com/sirupsen/logrus"
	"golang.org/x/crypto/ssh"
)

// downloadProgressInterval throttles how often a [SftpProgress] message is emitted while streaming a download, to
// avoid one progress message per 32 KiB frame on large files.
const downloadProgressInterval = 256 * 1024

// -----------------------------------------------------------------------------
// Wire payloads (see 02-protocol.md). Request payloads (client -> server) are decoded in [decodeSftpRequest]; response
// payloads (server -> client) are marshalled by [Conn.WriteMessage].
// -----------------------------------------------------------------------------

// SftpRequestID is the minimal payload carrying only the correlation id (e.g. download end).
type SftpRequestID struct {
	RequestID string `json:"requestId"`
}

// SftpPathRequest is used by list/stat/mkdir/download.
type SftpPathRequest struct {
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
}

// SftpRenameRequest renames/moves From to To.
type SftpRenameRequest struct {
	RequestID string `json:"requestId"`
	From      string `json:"from"`
	To        string `json:"to"`
}

// SftpRemoveRequest removes Path, recursively when Recursive is set.
type SftpRemoveRequest struct {
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

// SftpUploadRequest begins an upload of Size bytes to Path.
type SftpUploadRequest struct {
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
	Size      int64  `json:"size"`
}

// SftpUploadChunkRequest carries a base64-encoded slice of an upload; EOF marks the last chunk.
type SftpUploadChunkRequest struct {
	RequestID string `json:"requestId"`
	Data      string `json:"data"`
	EOF       bool   `json:"eof"`
}

// FileEntry is a single directory entry / stat result.
type FileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	Mode       string `json:"mode"`
	ModeBits   uint32 `json:"modeBits"`
	Mtime      int64  `json:"mtime"`
	IsDir      bool   `json:"isDir"`
	IsLink     bool   `json:"isLink"`
	LinkTarget string `json:"linkTarget,omitempty"`
}

// SftpResult acknowledges a metadata operation. Entries is set for "list", Stat for "stat".
type SftpResult struct {
	RequestID string      `json:"requestId"`
	Op        string      `json:"op"`
	OK        bool        `json:"ok"`
	Path      string      `json:"path,omitempty"`
	Entries   []FileEntry `json:"entries,omitempty"`
	Stat      *FileEntry  `json:"stat,omitempty"`
}

// SftpDownloadBegin precedes the binary download frames.
type SftpDownloadBegin struct {
	RequestID string `json:"requestId"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Mode      string `json:"mode"`
	Mtime     int64  `json:"mtime"`
}

// SftpProgress reports transfer progress. Direction is "download" or "upload".
type SftpProgress struct {
	RequestID   string `json:"requestId"`
	Transferred int64  `json:"transferred"`
	Total       int64  `json:"total"`
	Direction   string `json:"direction"`
}

// SftpError reports a per-operation failure.
type SftpError struct {
	RequestID string `json:"requestId,omitempty"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

// maxConcurrentUploads bounds how many in-flight uploads a single session may hold open at once. Each open upload
// pins a file handle on the device agent, so the cap protects the agent from a client that opens many uploads and
// never finishes them.
const maxConcurrentUploads = 16

// uploadState tracks an in-flight upload between its begin message and its EOF chunk. Bytes are written to tempPath
// and only moved onto finalPath (atomically) once the EOF chunk closes the file successfully, so an interrupted or
// failed upload never truncates or destroys the pre-existing destination file.
type uploadState struct {
	file        *sftp.File
	tempPath    string
	finalPath   string
	size        int64
	transferred int64
}

// decodeSftpRequest unmarshals an inbound SFTP request payload into its concrete type. It is called from
// [Conn.ReadMessage] for the client -> server SFTP kinds.
func decodeSftpRequest(kind messageKind, data json.RawMessage) (any, error) {
	var (
		value any
		err   error
	)

	switch kind {
	case messageKindSftpList, messageKindSftpStat, messageKindSftpMkdir, messageKindSftpDownload:
		var payload SftpPathRequest
		err = json.Unmarshal(data, &payload)
		value = payload
	case messageKindSftpRename:
		var payload SftpRenameRequest
		err = json.Unmarshal(data, &payload)
		value = payload
	case messageKindSftpRemove:
		var payload SftpRemoveRequest
		err = json.Unmarshal(data, &payload)
		value = payload
	case messageKindSftpUpload:
		var payload SftpUploadRequest
		err = json.Unmarshal(data, &payload)
		value = payload
	case messageKindSftpUploadChunk:
		var payload SftpUploadChunkRequest
		err = json.Unmarshal(data, &payload)
		value = payload
	case messageKindSftpCancel:
		var payload SftpRequestID
		err = json.Unmarshal(data, &payload)
		value = payload
	default:
		return nil, errors.Join(ErrConnReadMessageKindInvalid)
	}

	if err != nil {
		return nil, errors.Join(ErrConnReadMessageJSONInvalid, err)
	}

	return value, nil
}

// newSftpSession bridges a browser WebSocket to the agent's "sftp" subsystem. It mirrors [newSession]'s dial +
// authentication + session-uid relay, but instead of requesting a PTY and shell it opens the sftp subsystem and runs
// a gateway-side pkg/sftp client that services high-level file operations from the browser.
func newSftpSession(ctx context.Context, cache cache.Cache, conn *Conn, creds *Credentials, info Info) error {
	logger := log.WithFields(log.Fields{
		"user":   creds.Username,
		"device": creds.Device,
		"ip":     info.IP,
	})

	logger.Info("handling web sftp request started")

	defer logger.Info("handling web sftp request end")

	id := uuid.Generate()

	user := fmt.Sprintf("%s@%s", creds.Username, id)

	auth, err := getAuth(ctx, conn, creds)
	if err != nil {
		logger.WithError(err).Debug("failed to get the credentials")

		return ErrGetAuth
	}

	if err := cache.Set(ctx, "web-ip/"+user, fmt.Sprintf("%s:%s", creds.Device, info.IP), 1*time.Minute); err != nil {
		logger.WithError(err).Debug("failed to set the session IP on the cache")

		return err
	}

	defer cache.Delete(ctx, "web-ip/"+user) //nolint:errcheck

	connection, err := ssh.Dial("tcp", "localhost:2222", &ssh.ClientConfig{ //nolint: exhaustruct
		User:            user,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec
		BannerCallback: func(message string) error {
			if message != "" {
				return NewBannerError(message)
			}

			return nil
		},
	})
	if err != nil {
		var e *BannerError

		if errors.As(err, &e) {
			logger.WithError(e).Debug("failed to receive the connection banner")

			return mapBannerError(e)
		}

		logger.WithError(err).Debug("failed to dial to the ssh server")

		return ErrAuthentication
	}

	defer connection.Close() //nolint:errcheck

	// Ask the SSH server for this connection's session UID, keeping parity with the terminal bridge so the session is
	// tracked identically.
	sessionUID := ""
	if ok, reply, err := connection.SendRequest("session-uid@shellhub.io", true, nil); err == nil && ok {
		sessionUID = string(reply)
	}

	// Always relay the SESSION message. Besides carrying the UID, it is the web client's "authenticated and ready"
	// signal: the client must not send SFTP requests before it, because a public-key signature exchange (handled via
	// messageKindSignature) happens during the dial above and would otherwise consume the client's first request.
	if _, err := conn.WriteMessage(&Message{Kind: messageKindSession, Data: sessionUID}); err != nil {
		logger.WithError(err).Debug("failed to send the session UID to the web client")
	}

	sess, err := connection.NewSession()
	if err != nil {
		logger.WithError(err).Debug("failed to create a new session")

		return ErrSession
	}

	defer sess.Close() //nolint:errcheck

	stdin, err := sess.StdinPipe()
	if err != nil {
		logger.WithError(err).Debug("failed to create the stdin pipe")

		return err
	}

	stdout, err := sess.StdoutPipe()
	if err != nil {
		logger.WithError(err).Debug("failed to create the stdout pipe")

		return err
	}

	if err := sess.RequestSubsystem("sftp"); err != nil {
		logger.WithError(err).Debug("failed to request the sftp subsystem")

		return ErrSubsystem
	}

	client, err := sftp.NewClientPipe(stdout, stdin)
	if err != nil {
		logger.WithError(err).Debug("failed to create the sftp client")

		return ErrSftpClient
	}

	defer client.Close() //nolint:errcheck

	return serveSFTP(conn, client, logger)
}

// serveSFTP is the request/response dispatch loop. It reads one browser message at a time and services it against the
// pkg/sftp client. Because the loop is single-threaded, an in-flight download naturally serializes the socket (which
// is required — download binary frames are untagged) and upload state needs no locking.
func serveSFTP(conn *Conn, client *sftp.Client, logger *log.Entry) error {
	// The agent's sftp server starts in the OS user's HOME (see agent/sftp.go). An empty or "." path from the browser
	// resolves to it.
	home, err := client.Getwd()
	if err != nil || home == "" {
		home = "."
	}

	uploads := map[string]*uploadState{}

	defer func() {
		// Any upload still in-flight when the session ends never received its EOF, so its temp file must be
		// closed and removed — never promoted onto the destination — leaving the original file intact.
		for _, upload := range uploads {
			upload.file.Close()            //nolint:errcheck
			client.Remove(upload.tempPath) //nolint:errcheck
		}
	}()

	for {
		var message Message

		if _, err := conn.ReadMessage(&message); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}

			logger.WithError(err).Debug("failed to read the message from the sftp client")

			return nil
		}

		switch message.Kind {
		case messageKindSftpList:
			request := message.Data.(SftpPathRequest)
			handleList(conn, client, resolveDir(request.Path, home), request.RequestID)
		case messageKindSftpStat:
			request := message.Data.(SftpPathRequest)
			handleStat(conn, client, request.Path, request.RequestID)
		case messageKindSftpMkdir:
			request := message.Data.(SftpPathRequest)
			handleMkdir(conn, client, request.Path, request.RequestID)
		case messageKindSftpRename:
			handleRename(conn, client, message.Data.(SftpRenameRequest))
		case messageKindSftpRemove:
			handleRemove(conn, client, message.Data.(SftpRemoveRequest))
		case messageKindSftpDownload:
			request := message.Data.(SftpPathRequest)
			handleDownload(conn, client, request.Path, request.RequestID, logger)
		case messageKindSftpUpload:
			handleUploadBegin(conn, client, message.Data.(SftpUploadRequest), uploads)
		case messageKindSftpUploadChunk:
			handleUploadChunk(conn, client, message.Data.(SftpUploadChunkRequest), uploads)
		case messageKindSftpCancel:
			handleCancel(conn, client, message.Data.(SftpRequestID), uploads)
		default:
			// Server -> client kinds must never arrive inbound; ignore defensively.
		}
	}
}

// resolveDir maps an empty or "." request path to the agent's HOME directory.
func resolveDir(requested, home string) string {
	if requested == "" || requested == "." {
		return home
	}

	return requested
}

func handleList(conn *Conn, client *sftp.Client, dir, requestID string) {
	infos, err := client.ReadDir(dir)
	if err != nil {
		writeSftpError(conn, requestID, err)

		return
	}

	entries := make([]FileEntry, 0, len(infos))
	for _, info := range infos {
		entries = append(entries, fileInfoToEntry(client, dir, info))
	}

	writeSftpMessage(conn, messageKindSftpResult, SftpResult{
		RequestID: requestID,
		Op:        "list",
		OK:        true,
		Path:      dir,
		Entries:   entries,
	})
}

func handleStat(conn *Conn, client *sftp.Client, target, requestID string) {
	info, err := client.Lstat(target)
	if err != nil {
		writeSftpError(conn, requestID, err)

		return
	}

	entry := fileInfoToEntry(client, path.Dir(target), info)

	writeSftpMessage(conn, messageKindSftpResult, SftpResult{
		RequestID: requestID,
		Op:        "stat",
		OK:        true,
		Stat:      &entry,
	})
}

func handleMkdir(conn *Conn, client *sftp.Client, target, requestID string) {
	if err := client.MkdirAll(target); err != nil {
		writeSftpError(conn, requestID, err)

		return
	}

	writeSftpOK(conn, requestID, "mkdir")
}

func handleRename(conn *Conn, client *sftp.Client, request SftpRenameRequest) {
	if err := client.Rename(request.From, request.To); err != nil {
		writeSftpError(conn, request.RequestID, err)

		return
	}

	writeSftpOK(conn, request.RequestID, "rename")
}

func handleRemove(conn *Conn, client *sftp.Client, request SftpRemoveRequest) {
	if err := removePath(client, request.Path, request.Recursive); err != nil {
		writeSftpError(conn, request.RequestID, err)

		return
	}

	writeSftpOK(conn, request.RequestID, "remove")
}

// removePath deletes a file or directory. Directories are removed recursively when recursive is set; otherwise a
// non-empty directory yields the server's "directory not empty" error. A symlink is removed as a link (Lstat), never
// following it.
func removePath(client *sftp.Client, target string, recursive bool) error {
	info, err := client.Lstat(target)
	if err != nil {
		return err
	}

	if !info.IsDir() {
		return client.Remove(target)
	}

	if !recursive {
		return client.RemoveDirectory(target)
	}

	entries, err := client.ReadDir(target)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if err := removePath(client, path.Join(target, entry.Name()), true); err != nil {
			return err
		}
	}

	return client.RemoveDirectory(target)
}

func handleDownload(conn *Conn, client *sftp.Client, target, requestID string, logger *log.Entry) {
	file, err := client.Open(target)
	if err != nil {
		writeSftpError(conn, requestID, errors.Join(ErrSftpOpen, err))

		return
	}

	defer file.Close() //nolint:errcheck

	// Reject anything that is not a regular file. A directory handle, a FIFO, or a character device such as
	// /dev/zero would otherwise stream without ever returning io.EOF and — because the dispatch loop services one
	// message at a time — would wedge the whole session with no way to recover but tearing down the socket.
	info, err := file.Stat()
	if err != nil {
		writeSftpError(conn, requestID, errors.Join(ErrSftpOpen, err))

		return
	}

	if !info.Mode().IsRegular() {
		writeSftpError(conn, requestID, errors.Join(ErrSftpOp, errors.New("not a regular file")))

		return
	}

	var (
		size  = info.Size()
		mode  = info.Mode().String()
		mtime = info.ModTime().Unix()
	)

	if _, err := conn.WriteMessage(&Message{
		Kind: messageKindSftpDownloadBegin,
		Data: SftpDownloadBegin{RequestID: requestID, Name: path.Base(target), Size: size, Mode: mode, Mtime: mtime},
	}); err != nil {
		return
	}

	buffer := make([]byte, 32*1024)

	var transferred, reported int64

	for {
		read, err := file.Read(buffer)
		if read > 0 {
			if _, werr := conn.WriteBinary(buffer[:read]); werr != nil {
				logger.WithError(werr).Debug("failed to write the download chunk to the web client")

				return
			}

			transferred += int64(read)

			if transferred-reported >= downloadProgressInterval {
				reported = transferred
				writeSftpMessage(conn, messageKindSftpProgress, SftpProgress{
					RequestID: requestID, Transferred: transferred, Total: size, Direction: "download",
				})
			}
		}

		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}

			writeSftpError(conn, requestID, err)

			return
		}
	}

	// Final progress at 100% then the end marker.
	writeSftpMessage(conn, messageKindSftpProgress, SftpProgress{
		RequestID: requestID, Transferred: transferred, Total: size, Direction: "download",
	})
	writeSftpMessage(conn, messageKindSftpDownloadEnd, SftpRequestID{RequestID: requestID})
}

func handleUploadBegin(conn *Conn, client *sftp.Client, request SftpUploadRequest, uploads map[string]*uploadState) {
	// A duplicate requestId would otherwise overwrite the map entry and orphan the previous open handle, so abort
	// any existing upload under the same id first.
	if old, ok := uploads[request.RequestID]; ok {
		old.file.Close()            //nolint:errcheck
		client.Remove(old.tempPath) //nolint:errcheck
		delete(uploads, request.RequestID)
	}

	// Cap the number of concurrent in-flight uploads so a client cannot pin an unbounded number of agent file
	// handles by opening uploads it never finishes.
	if len(uploads) >= maxConcurrentUploads {
		writeSftpError(conn, request.RequestID, errors.Join(ErrSftpOp, errors.New("too many concurrent uploads")))

		return
	}

	// Write into a sibling temp file rather than the destination itself. pkg/sftp's Create opens
	// O_RDWR|O_CREATE|O_TRUNC, so opening the destination directly would truncate the user's existing file the
	// instant the upload starts — any later interruption would leave them with a partial/empty file. Staging in a
	// temp file and renaming on success keeps the original intact until the transfer completes.
	tempPath := uploadTempPath(request.Path, request.RequestID)

	file, err := client.Create(tempPath)
	if err != nil {
		writeSftpError(conn, request.RequestID, errors.Join(ErrSftpOpen, err))

		return
	}

	uploads[request.RequestID] = &uploadState{
		file:      file,
		tempPath:  tempPath,
		finalPath: request.Path,
		size:      request.Size,
	}
}

func handleUploadChunk(conn *Conn, client *sftp.Client, request SftpUploadChunkRequest, uploads map[string]*uploadState) {
	state, ok := uploads[request.RequestID]
	if !ok {
		writeSftpError(conn, request.RequestID, errors.Join(ErrSftpOp, errors.New("upload session not found")))

		return
	}

	if request.Data != "" {
		raw, err := base64.StdEncoding.DecodeString(request.Data)
		if err != nil {
			abortUpload(conn, client, uploads, request.RequestID, err)

			return
		}

		// Enforce the announced size so a client cannot stream unbounded bytes past what it declared.
		if state.size >= 0 && state.transferred+int64(len(raw)) > state.size {
			abortUpload(conn, client, uploads, request.RequestID, errors.Join(ErrSftpOp, errors.New("upload exceeded declared size")))

			return
		}

		if _, err := state.file.Write(raw); err != nil {
			abortUpload(conn, client, uploads, request.RequestID, err)

			return
		}

		state.transferred += int64(len(raw))

		writeSftpMessage(conn, messageKindSftpProgress, SftpProgress{
			RequestID: request.RequestID, Transferred: state.transferred, Total: state.size, Direction: "upload",
		})
	}

	if request.EOF {
		closeErr := state.file.Close()
		delete(uploads, request.RequestID)

		if closeErr != nil {
			client.Remove(state.tempPath) //nolint:errcheck
			writeSftpError(conn, request.RequestID, closeErr)

			return
		}

		// Atomically move the fully-written temp file onto the destination. The agent runs pkg/sftp's server,
		// whose rename is os.Rename, so this overwrites any existing file in a single step. On failure the temp
		// file is removed and the destination is left untouched.
		if err := client.Rename(state.tempPath, state.finalPath); err != nil {
			client.Remove(state.tempPath) //nolint:errcheck
			writeSftpError(conn, request.RequestID, errors.Join(ErrSftpOp, err))

			return
		}

		writeSftpOK(conn, request.RequestID, "upload")
	}
}

// handleCancel aborts an in-flight upload identified by requestId, closing and removing its temp file so the
// destination is left untouched. Downloads stream synchronously and finish on their own, so a cancel that does not
// match an active upload is a no-op.
func handleCancel(conn *Conn, client *sftp.Client, request SftpRequestID, uploads map[string]*uploadState) {
	if _, ok := uploads[request.RequestID]; ok {
		abortUpload(conn, client, uploads, request.RequestID, errors.Join(ErrSftpOp, errors.New("upload canceled")))
	}
}

// abortUpload closes and forgets a failed upload, removes its temp file so no partial artefact is left behind, then
// reports the error.
func abortUpload(conn *Conn, client *sftp.Client, uploads map[string]*uploadState, requestID string, err error) {
	if state, ok := uploads[requestID]; ok {
		state.file.Close()            //nolint:errcheck
		client.Remove(state.tempPath) //nolint:errcheck
		delete(uploads, requestID)
	}

	writeSftpError(conn, requestID, err)
}

// uploadTempPath derives a hidden, per-request temp file path in the destination's directory (so the final rename is
// same-filesystem and therefore atomic). The requestId is sanitised to keep the temp name within that directory.
func uploadTempPath(target, requestID string) string {
	return path.Join(path.Dir(target), "."+path.Base(target)+".shellhub-"+sanitizeID(requestID)+".part")
}

// sanitizeID reduces an arbitrary client-supplied requestId to a filename-safe token so it cannot alter the temp
// file's directory.
func sanitizeID(id string) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-':
			return r
		default:
			return '_'
		}
	}, id)

	if safe == "" {
		return "upload"
	}

	return safe
}

// fileInfoToEntry converts an [os.FileInfo] into a [FileEntry], resolving symlink targets best-effort.
func fileInfoToEntry(client *sftp.Client, dir string, info os.FileInfo) FileEntry {
	full := path.Join(dir, info.Name())

	entry := FileEntry{
		Name:     info.Name(),
		Path:     full,
		Size:     info.Size(),
		Mode:     info.Mode().String(),
		ModeBits: uint32(info.Mode()),
		Mtime:    info.ModTime().Unix(),
		IsDir:    info.IsDir(),
		IsLink:   info.Mode()&os.ModeSymlink != 0,
	}

	if entry.IsLink {
		if target, err := client.ReadLink(full); err == nil {
			entry.LinkTarget = target
		}
	}

	return entry
}

func writeSftpOK(conn *Conn, requestID, op string) {
	writeSftpMessage(conn, messageKindSftpResult, SftpResult{RequestID: requestID, Op: op, OK: true})
}

func writeSftpError(conn *Conn, requestID string, err error) {
	writeSftpMessage(conn, messageKindSftpError, SftpError{
		RequestID: requestID,
		Code:      sftpErrorCode(err),
		Message:   err.Error(),
	})
}

func writeSftpMessage(conn *Conn, kind messageKind, data any) {
	if _, err := conn.WriteMessage(&Message{Kind: kind, Data: data}); err != nil {
		log.WithError(err).Debug("failed to write the sftp message to the web client")
	}
}

// sftpErrorCode maps an error from the pkg/sftp client to a stable, browser-friendly code. pkg/sftp's client already
// normalises "no such file" to [os.ErrNotExist] and "permission denied" to [os.ErrPermission]; other status packets
// surface as [sftp.StatusError].
func sftpErrorCode(err error) string {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "not_found"
	case errors.Is(err, os.ErrPermission):
		return "permission_denied"
	case errors.Is(err, os.ErrExist):
		return "exists"
	}

	// Other status packets surface as [sftp.StatusError]. Compare the raw SSH_FX code (RFC draft-ietf-secsh-filexfer)
	// rather than the package's typed constants to keep this resilient across pkg/sftp versions.
	var status *sftp.StatusError
	if errors.As(err, &status) {
		switch status.Code {
		case sshFxNoSuchFile:
			return "not_found"
		case sshFxPermissionDenied:
			return "permission_denied"
		case sshFxOpUnsupported:
			return "unsupported"
		}
	}

	return "io"
}

// SSH_FX_* status codes from the SFTP protocol, used to classify [sftp.StatusError].
const (
	sshFxNoSuchFile       = 2
	sshFxPermissionDenied = 3
	sshFxOpUnsupported    = 8
)
