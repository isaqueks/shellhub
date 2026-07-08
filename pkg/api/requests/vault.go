package requests

// VaultGet is the request to retrieve the authenticated user's vault in the current namespace.
type VaultGet struct {
	UserID   string `header:"X-ID" validate:"required,uuid"`
	TenantID string `header:"X-Tenant-ID" validate:"required,uuid"`
}

// VaultDelete is the request to delete the authenticated user's vault in the current namespace.
type VaultDelete struct {
	UserID   string `header:"X-ID" validate:"required,uuid"`
	TenantID string `header:"X-Tenant-ID" validate:"required,uuid"`
}

// SaveVaultMeta is the request to save the vault metadata (KDF parameters and verifier),
// creating the vault when it does not exist yet. Meta is an opaque JSON string.
type SaveVaultMeta struct {
	UserID   string `header:"X-ID" validate:"required,uuid"`
	TenantID string `header:"X-Tenant-ID" validate:"required,uuid"`
	Meta     string `json:"meta" validate:"required,max=4096"`
}

// SaveVaultData is the request to save the encrypted vault data. The vault must already
// exist and Version must match the current vault version (optimistic concurrency). Data
// is an opaque JSON string.
type SaveVaultData struct {
	UserID   string `header:"X-ID" validate:"required,uuid"`
	TenantID string `header:"X-Tenant-ID" validate:"required,uuid"`
	Data     string `json:"data" validate:"required,max=1048576"`
	Version  uint64 `json:"version" validate:"required,min=1"`
}

// SaveVaultSettings is the request to save the vault settings, creating the vault when it
// does not exist yet. Settings is an opaque JSON string.
type SaveVaultSettings struct {
	UserID   string `header:"X-ID" validate:"required,uuid"`
	TenantID string `header:"X-Tenant-ID" validate:"required,uuid"`
	Settings string `json:"settings" validate:"required,max=4096"`
}
