package services

import (
	"context"
	"testing"

	"github.com/shellhub-io/shellhub/api/store"
	storemock "github.com/shellhub-io/shellhub/api/store/mocks"
	"github.com/shellhub-io/shellhub/pkg/api/requests"
	"github.com/shellhub-io/shellhub/pkg/api/responses"
	storecache "github.com/shellhub-io/shellhub/pkg/cache"
	"github.com/shellhub-io/shellhub/pkg/models"
	"github.com/stretchr/testify/require"
)

const (
	vaultUserID   = "00000000-0000-4000-0000-000000000000"
	vaultTenantID = "10000000-0000-4000-0000-000000000000"
)

func TestGetVault(t *testing.T) {
	type Expected struct {
		res *responses.Vault
		err error
	}

	storeMock := storemock.NewMockStore(t)

	cases := []struct {
		description   string
		req           *requests.VaultGet
		requiredMocks func(context.Context)
		expected      Expected
	}{
		{
			description: "fails when the vault is not found",
			req:         &requests.VaultGet{UserID: vaultUserID, TenantID: vaultTenantID},
			requiredMocks: func(ctx context.Context) {
				storeMock.
					On("VaultGet", ctx, vaultUserID, vaultTenantID).
					Return(nil, store.ErrNoDocuments).
					Once()
			},
			expected: Expected{
				res: nil,
				err: NewErrVaultNotFound(vaultTenantID, store.ErrNoDocuments),
			},
		},
		{
			description: "succeeds",
			req:         &requests.VaultGet{UserID: vaultUserID, TenantID: vaultTenantID},
			requiredMocks: func(ctx context.Context) {
				storeMock.
					On("VaultGet", ctx, vaultUserID, vaultTenantID).
					Return(&models.Vault{Meta: `{"m":1}`, Data: `{"d":1}`, Version: 3}, nil).
					Once()
			},
			expected: Expected{
				res: &responses.Vault{Meta: `{"m":1}`, Data: `{"d":1}`, Version: 3},
				err: nil,
			},
		},
	}

	s := NewService(storeMock, privateKey, publicKey, storecache.NewNullCache(), clientMock)

	for _, tc := range cases {
		t.Run(tc.description, func(t *testing.T) {
			ctx := context.Background()
			tc.requiredMocks(ctx)

			res, err := s.GetVault(ctx, tc.req)
			require.Equal(t, tc.expected.res, res)
			require.Equal(t, tc.expected.err, err)
		})
	}

	storeMock.AssertExpectations(t)
}

func TestSaveVaultMeta(t *testing.T) {
	type Expected struct {
		res *responses.VaultVersion
		err error
	}

	storeMock := storemock.NewMockStore(t)

	cases := []struct {
		description   string
		req           *requests.SaveVaultMeta
		requiredMocks func(context.Context)
		expected      Expected
	}{
		{
			description: "succeeds and returns the new version",
			req:         &requests.SaveVaultMeta{UserID: vaultUserID, TenantID: vaultTenantID, Meta: `{"m":1}`},
			requiredMocks: func(ctx context.Context) {
				storeMock.
					On("VaultSaveMeta", ctx, vaultUserID, vaultTenantID, `{"m":1}`).
					Return(&models.Vault{Version: 1}, nil).
					Once()
			},
			expected: Expected{
				res: &responses.VaultVersion{Version: 1},
				err: nil,
			},
		},
	}

	s := NewService(storeMock, privateKey, publicKey, storecache.NewNullCache(), clientMock)

	for _, tc := range cases {
		t.Run(tc.description, func(t *testing.T) {
			ctx := context.Background()
			tc.requiredMocks(ctx)

			res, err := s.SaveVaultMeta(ctx, tc.req)
			require.Equal(t, tc.expected.res, res)
			require.Equal(t, tc.expected.err, err)
		})
	}

	storeMock.AssertExpectations(t)
}

func TestSaveVaultData(t *testing.T) {
	type Expected struct {
		res *responses.VaultVersion
		err error
	}

	storeMock := storemock.NewMockStore(t)

	cases := []struct {
		description   string
		req           *requests.SaveVaultData
		requiredMocks func(context.Context)
		expected      Expected
	}{
		{
			description: "fails when the vault does not exist",
			req:         &requests.SaveVaultData{UserID: vaultUserID, TenantID: vaultTenantID, Data: `{"iv":"x"}`, Version: 1},
			requiredMocks: func(ctx context.Context) {
				storeMock.
					On("VaultSaveData", ctx, vaultUserID, vaultTenantID, `{"iv":"x"}`, uint64(1)).
					Return(nil, store.ErrNoDocuments).
					Once()
			},
			expected: Expected{
				res: nil,
				err: NewErrVaultNotFound(vaultTenantID, store.ErrNoDocuments),
			},
		},
		{
			description: "fails with a conflict when the version is stale",
			req:         &requests.SaveVaultData{UserID: vaultUserID, TenantID: vaultTenantID, Data: `{"iv":"x"}`, Version: 1},
			requiredMocks: func(ctx context.Context) {
				storeMock.
					On("VaultSaveData", ctx, vaultUserID, vaultTenantID, `{"iv":"x"}`, uint64(1)).
					Return(nil, store.ErrDuplicate).
					Once()
			},
			expected: Expected{
				res: nil,
				err: NewErrVaultConflict(store.ErrDuplicate),
			},
		},
		{
			description: "succeeds and returns the bumped version",
			req:         &requests.SaveVaultData{UserID: vaultUserID, TenantID: vaultTenantID, Data: `{"iv":"x"}`, Version: 1},
			requiredMocks: func(ctx context.Context) {
				storeMock.
					On("VaultSaveData", ctx, vaultUserID, vaultTenantID, `{"iv":"x"}`, uint64(1)).
					Return(&models.Vault{Version: 2}, nil).
					Once()
			},
			expected: Expected{
				res: &responses.VaultVersion{Version: 2},
				err: nil,
			},
		},
	}

	s := NewService(storeMock, privateKey, publicKey, storecache.NewNullCache(), clientMock)

	for _, tc := range cases {
		t.Run(tc.description, func(t *testing.T) {
			ctx := context.Background()
			tc.requiredMocks(ctx)

			res, err := s.SaveVaultData(ctx, tc.req)
			require.Equal(t, tc.expected.res, res)
			require.Equal(t, tc.expected.err, err)
		})
	}

	storeMock.AssertExpectations(t)
}

func TestSaveVaultSettings(t *testing.T) {
	storeMock := storemock.NewMockStore(t)

	req := &requests.SaveVaultSettings{UserID: vaultUserID, TenantID: vaultTenantID, Settings: `{"lockOnHidden":true}`}

	s := NewService(storeMock, privateKey, publicKey, storecache.NewNullCache(), clientMock)

	t.Run("succeeds and returns the new version", func(t *testing.T) {
		ctx := context.Background()
		storeMock.
			On("VaultSaveSettings", ctx, vaultUserID, vaultTenantID, `{"lockOnHidden":true}`).
			Return(&models.Vault{Version: 5}, nil).
			Once()

		res, err := s.SaveVaultSettings(ctx, req)
		require.NoError(t, err)
		require.Equal(t, &responses.VaultVersion{Version: 5}, res)
	})

	storeMock.AssertExpectations(t)
}

func TestDeleteVault(t *testing.T) {
	storeMock := storemock.NewMockStore(t)

	req := &requests.VaultDelete{UserID: vaultUserID, TenantID: vaultTenantID}

	s := NewService(storeMock, privateKey, publicKey, storecache.NewNullCache(), clientMock)

	t.Run("fails when the vault does not exist", func(t *testing.T) {
		ctx := context.Background()
		storeMock.
			On("VaultDelete", ctx, vaultUserID, vaultTenantID).
			Return(store.ErrNoDocuments).
			Once()

		err := s.DeleteVault(ctx, req)
		require.Equal(t, NewErrVaultNotFound(vaultTenantID, store.ErrNoDocuments), err)
	})

	t.Run("succeeds", func(t *testing.T) {
		ctx := context.Background()
		storeMock.
			On("VaultDelete", ctx, vaultUserID, vaultTenantID).
			Return(nil).
			Once()

		require.NoError(t, s.DeleteVault(ctx, req))
	})

	storeMock.AssertExpectations(t)
}
