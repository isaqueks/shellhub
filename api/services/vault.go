package services

import (
	"context"
	"errors"

	"github.com/shellhub-io/shellhub/api/store"
	"github.com/shellhub-io/shellhub/pkg/api/requests"
	"github.com/shellhub-io/shellhub/pkg/api/responses"
)

type VaultService interface {
	// GetVault returns the authenticated user's vault in the current namespace. It returns a
	// not-found error when the vault does not exist yet.
	GetVault(ctx context.Context, req *requests.VaultGet) (*responses.Vault, error)

	// SaveVaultMeta saves the vault metadata, creating the vault when it does not exist yet.
	SaveVaultMeta(ctx context.Context, req *requests.SaveVaultMeta) (*responses.VaultVersion, error)

	// SaveVaultData saves the encrypted vault data. The vault must already exist (not-found
	// error otherwise) and req.Version must match the current version (conflict error
	// otherwise).
	SaveVaultData(ctx context.Context, req *requests.SaveVaultData) (*responses.VaultVersion, error)

	// SaveVaultSettings saves the vault settings, creating the vault when it does not exist yet.
	SaveVaultSettings(ctx context.Context, req *requests.SaveVaultSettings) (*responses.VaultVersion, error)

	// DeleteVault deletes the authenticated user's vault in the current namespace.
	DeleteVault(ctx context.Context, req *requests.VaultDelete) error
}

func (s *service) GetVault(ctx context.Context, req *requests.VaultGet) (*responses.Vault, error) {
	vault, err := s.store.VaultGet(ctx, req.UserID, req.TenantID)
	if err != nil {
		if errors.Is(err, store.ErrNoDocuments) {
			return nil, NewErrVaultNotFound(req.TenantID, err)
		}

		return nil, err
	}

	return responses.VaultFromModel(vault), nil
}

func (s *service) SaveVaultMeta(ctx context.Context, req *requests.SaveVaultMeta) (*responses.VaultVersion, error) {
	vault, err := s.store.VaultSaveMeta(ctx, req.UserID, req.TenantID, req.Meta)
	if err != nil {
		return nil, err
	}

	return responses.VaultVersionFromModel(vault), nil
}

func (s *service) SaveVaultData(ctx context.Context, req *requests.SaveVaultData) (*responses.VaultVersion, error) {
	vault, err := s.store.VaultSaveData(ctx, req.UserID, req.TenantID, req.Data, req.Version)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNoDocuments):
			return nil, NewErrVaultNotFound(req.TenantID, err)
		case errors.Is(err, store.ErrDuplicate):
			return nil, NewErrVaultConflict(err)
		default:
			return nil, err
		}
	}

	return responses.VaultVersionFromModel(vault), nil
}

func (s *service) SaveVaultSettings(ctx context.Context, req *requests.SaveVaultSettings) (*responses.VaultVersion, error) {
	vault, err := s.store.VaultSaveSettings(ctx, req.UserID, req.TenantID, req.Settings)
	if err != nil {
		return nil, err
	}

	return responses.VaultVersionFromModel(vault), nil
}

func (s *service) DeleteVault(ctx context.Context, req *requests.VaultDelete) error {
	if err := s.store.VaultDelete(ctx, req.UserID, req.TenantID); err != nil {
		if errors.Is(err, store.ErrNoDocuments) {
			return NewErrVaultNotFound(req.TenantID, err)
		}

		return err
	}

	return nil
}
