package models

import "time"

// Vault is a user's encrypted SSH key vault within a namespace.
//
// All encryption happens in the browser (PBKDF2 + AES-GCM derived from the vault
// password); Meta, Data and Settings are opaque strings that the server stores and
// returns verbatim, never parsing their contents. There is at most one vault per
// (UserID, TenantID) pair.
type Vault struct {
	// UserID is the ID of the user who owns the vault.
	UserID string `json:"-"`
	// TenantID is the namespace the vault belongs to.
	TenantID string `json:"-"`
	// Meta holds the KDF parameters and password verifier, as an opaque JSON string.
	Meta string `json:"meta,omitempty"`
	// Data holds the encrypted vault payload, as an opaque JSON string.
	Data string `json:"data,omitempty"`
	// Settings holds the vault settings, as an opaque JSON string.
	Settings string `json:"settings,omitempty"`
	// Version is incremented on every successful write and used for optimistic
	// concurrency when saving data.
	Version uint64 `json:"version"`
	// CreatedAt is the vault's creation date.
	CreatedAt time.Time `json:"created_at"`
	// UpdatedAt is the vault's last update date.
	UpdatedAt time.Time `json:"updated_at"`
}
