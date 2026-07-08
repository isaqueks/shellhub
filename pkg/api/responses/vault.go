package responses

import (
	"time"

	"github.com/shellhub-io/shellhub/pkg/models"
)

// Vault is the response body for GET /api/vault. The opaque blobs are omitted when empty
// so a freshly-created vault (meta only) does not report empty data/settings.
type Vault struct {
	Meta      string    `json:"meta,omitempty"`
	Data      string    `json:"data,omitempty"`
	Settings  string    `json:"settings,omitempty"`
	Version   uint64    `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func VaultFromModel(m *models.Vault) *Vault {
	return &Vault{
		Meta:      m.Meta,
		Data:      m.Data,
		Settings:  m.Settings,
		Version:   m.Version,
		CreatedAt: m.CreatedAt,
		UpdatedAt: m.UpdatedAt,
	}
}

// VaultVersion is the response body for the vault write endpoints, carrying the current
// vault version after the write.
type VaultVersion struct {
	Version uint64 `json:"version"`
}

func VaultVersionFromModel(m *models.Vault) *VaultVersion {
	return &VaultVersion{Version: m.Version}
}
