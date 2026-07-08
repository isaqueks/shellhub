package store

import (
	"context"

	"github.com/shellhub-io/shellhub/pkg/models"
)

type VaultStore interface {
	// VaultGet returns the vault owned by userID within the tenantID namespace. It returns
	// ErrNoDocuments when the vault does not exist.
	VaultGet(ctx context.Context, userID, tenantID string) (*models.Vault, error)

	// VaultSaveMeta upserts the vault metadata: it creates the vault at version 1 when it
	// does not exist yet and bumps the version otherwise. It returns the resulting vault.
	VaultSaveMeta(ctx context.Context, userID, tenantID, meta string) (*models.Vault, error)

	// VaultSaveData updates the encrypted vault data using optimistic concurrency: the write
	// only succeeds when version matches the current vault version, bumping it on success. It
	// returns ErrNoDocuments when the vault does not exist and ErrDuplicate when version is
	// stale. It returns the resulting vault on success.
	VaultSaveData(ctx context.Context, userID, tenantID, data string, version uint64) (*models.Vault, error)

	// VaultSaveSettings upserts the vault settings: it creates the vault at version 1 when it
	// does not exist yet and bumps the version otherwise. It returns the resulting vault.
	VaultSaveSettings(ctx context.Context, userID, tenantID, settings string) (*models.Vault, error)

	// VaultDelete removes the vault owned by userID within the tenantID namespace. It returns
	// ErrNoDocuments when there is no vault to delete.
	VaultDelete(ctx context.Context, userID, tenantID string) error
}
