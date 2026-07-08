package web

type messageKind uint8

const (
	// messageKindInput is the identifier to a input message. This kind of message can be directly send to [web.Conn].
	messageKindInput messageKind = iota + 1
	// messageKindResize is the identifier to a resize request message. This kind of message contains the number of
	// columns and rows what the terminal should have.
	messageKindResize
	// messageKindSignature is the identifier to a signature message. This kind of message contains the data to be
	// signed by the user's private key.
	messageKindSignature
	// messageKindError is the identifier to output an erro rmessage. This kind of message contains data to be show
	// in terminal for information propose.
	messageKindError
	// messageKindSession carries the server session UID to the web client, so a client-side recording can be tied
	// to its session. This kind of message contains the session UID as a string.
	messageKindSession

	// The kinds below drive the Web SFTP file browser. Client->server request kinds (6-13) carry a client-generated
	// "requestId" so the browser can correlate the matching response. Server->client kinds (14-18) echo it back.
	//
	// messageKindSftpList requests a directory listing. Data: SftpPathRequest.
	messageKindSftpList // 6
	// messageKindSftpStat requests metadata for a single path. Data: SftpPathRequest.
	messageKindSftpStat // 7
	// messageKindSftpMkdir creates a directory (recursively). Data: SftpPathRequest.
	messageKindSftpMkdir // 8
	// messageKindSftpRename renames/moves a path. Data: SftpRenameRequest.
	messageKindSftpRename // 9
	// messageKindSftpRemove removes a path (optionally recursive). Data: SftpRemoveRequest.
	messageKindSftpRemove // 10
	// messageKindSftpDownload streams a remote file to the browser. Data: SftpPathRequest.
	messageKindSftpDownload // 11
	// messageKindSftpUpload begins an upload to a remote path. Data: SftpUploadRequest.
	messageKindSftpUpload // 12
	// messageKindSftpUploadChunk carries a base64 upload chunk. Data: SftpUploadChunkRequest.
	messageKindSftpUploadChunk // 13
	// messageKindSftpResult acknowledges a metadata op (list/stat/mkdir/rename/remove/upload). Data: SftpResult.
	messageKindSftpResult // 14
	// messageKindSftpDownloadBegin precedes the binary download frames. Data: SftpDownloadBegin.
	messageKindSftpDownloadBegin // 15
	// messageKindSftpDownloadEnd terminates a download. Data: SftpRequestID.
	messageKindSftpDownloadEnd // 16
	// messageKindSftpProgress reports transfer progress. Data: SftpProgress.
	messageKindSftpProgress // 17
	// messageKindSftpError reports a per-operation failure. Data: SftpError.
	messageKindSftpError // 18
	// messageKindSftpCancel aborts an in-flight transfer identified by requestId (client->server). It is used to
	// cancel an upload (the gateway closes and removes the temp file so the destination is untouched). Data:
	// SftpRequestID.
	messageKindSftpCancel // 19
)

// MessageMinSize is the minimum size of a message in bytes. This is used to validate if the message is valid.
const MessageMinSize = 20

// Message is the structure used to send and receive messages through the [web.Conn].
//
// A message min size could match with [MessageMinSize] constant, which is the size of the JSON object without data.
type Message struct {
	Kind messageKind `json:"kind"`
	Data any         `json:"data"`
}
