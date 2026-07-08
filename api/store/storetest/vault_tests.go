package storetest

import (
	"context"
	"testing"

	"github.com/shellhub-io/shellhub/api/store"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (s *Suite) TestVaultSaveMetaAndGet(t *testing.T) {
	ctx := context.Background()
	st := s.provider.Store()

	t.Run("creates the vault at version 1 and reads it back", func(t *testing.T) {
		require.NoError(t, s.provider.CleanDatabase(t))

		userID := s.CreateUser(t)
		tenantID := s.CreateNamespace(t, WithOwner(userID))

		vault, err := st.VaultSaveMeta(ctx, userID, tenantID, `{"version":1}`)
		require.NoError(t, err)
		require.NotNil(t, vault)
		assert.Equal(t, uint64(1), vault.Version)
		assert.Equal(t, `{"version":1}`, vault.Meta)

		got, err := st.VaultGet(ctx, userID, tenantID)
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, `{"version":1}`, got.Meta)
		assert.Equal(t, uint64(1), got.Version)
	})

	t.Run("bumps the version when the vault already exists", func(t *testing.T) {
		require.NoError(t, s.provider.CleanDatabase(t))

		userID := s.CreateUser(t)
		tenantID := s.CreateNamespace(t, WithOwner(userID))

		_, err := st.VaultSaveMeta(ctx, userID, tenantID, `{"v":1}`)
		require.NoError(t, err)

		vault, err := st.VaultSaveMeta(ctx, userID, tenantID, `{"v":2}`)
		require.NoError(t, err)
		assert.Equal(t, uint64(2), vault.Version)
		assert.Equal(t, `{"v":2}`, vault.Meta)
	})
}

func (s *Suite) TestVaultGetNotFound(t *testing.T) {
	ctx := context.Background()
	st := s.provider.Store()

	t.Run("fails when the vault does not exist", func(t *testing.T) {
		require.NoError(t, s.provider.CleanDatabase(t))

		userID := s.CreateUser(t)
		tenantID := s.CreateNamespace(t, WithOwner(userID))

		vault, err := st.VaultGet(ctx, userID, tenantID)
		assert.ErrorIs(t, err, store.ErrNoDocuments)
		assert.Nil(t, vault)
	})
}

func (s *Suite) TestVaultSaveData(t *testing.T) {
	ctx := context.Background()
	st := s.provider.Store()

	t.Run("fails with ErrNoDocuments when the vault does not exist", func(t *testing.T) {
		require.NoError(t, s.provider.CleanDatabase(t))

		userID := s.CreateUser(t)
		tenantID := s.CreateNamespace(t, WithOwner(userID))

		vault, err := st.VaultSaveData(ctx, userID, tenantID, `{"iv":"x"}`, 1)
		assert.ErrorIs(t, err, store.ErrNoDocuments)
		assert.Nil(t, vault)
	})

	t.Run("saves data and bumps the version when the version matches", func(t *testing.T) {
		require.NoError(t, s.provider.CleanDatabase(t))

		userID := s.CreateUser(t)
		tenantID := s.CreateNamespace(t, WithOwner(userID))

		meta, err := st.VaultSaveMeta(ctx, userID, tenantID, `{"m":1}`)
		require.NoError(t, err)

		vault, err := st.VaultSaveData(ctx, userID, tenantID, `{"iv":"x","ciphertext":"y"}`, meta.Version)
		require.NoError(t, err)
		require.NotNil(t, vault)
		assert.Equal(t, meta.Version+1, vault.Version)
		assert.Equal(t, `{"iv":"x","ciphertext":"y"}`, vault.Data)
	})

	t.Run("fails with ErrDuplicate when the version is stale", func(t *testing.T) {
		require.NoError(t, s.provider.CleanDatabase(t))

		userID := s.CreateUser(t)
		tenantID := s.CreateNamespace(t, WithOwner(userID))

		_, err := st.VaultSaveMeta(ctx, userID, tenantID, `{"m":1}`) // creates version 1
		require.NoError(t, err)

		vault, err := st.VaultSaveData(ctx, userID, tenantID, `{"d":1}`, 999)
		assert.ErrorIs(t, err, store.ErrDuplicate)
		assert.Nil(t, vault)
	})
}

func (s *Suite) TestVaultSaveSettings(t *testing.T) {
	ctx := context.Background()
	st := s.provider.Store()

	t.Run("creates the vault and stores settings", func(t *testing.T) {
		require.NoError(t, s.provider.CleanDatabase(t))

		userID := s.CreateUser(t)
		tenantID := s.CreateNamespace(t, WithOwner(userID))

		vault, err := st.VaultSaveSettings(ctx, userID, tenantID, `{"lockOnHidden":true}`)
		require.NoError(t, err)
		require.NotNil(t, vault)
		assert.Equal(t, uint64(1), vault.Version)
		assert.Equal(t, `{"lockOnHidden":true}`, vault.Settings)
	})
}

func (s *Suite) TestVaultDelete(t *testing.T) {
	ctx := context.Background()
	st := s.provider.Store()

	t.Run("fails when there is no vault to delete", func(t *testing.T) {
		require.NoError(t, s.provider.CleanDatabase(t))

		userID := s.CreateUser(t)
		tenantID := s.CreateNamespace(t, WithOwner(userID))

		err := st.VaultDelete(ctx, userID, tenantID)
		assert.ErrorIs(t, err, store.ErrNoDocuments)
	})

	t.Run("removes the vault", func(t *testing.T) {
		require.NoError(t, s.provider.CleanDatabase(t))

		userID := s.CreateUser(t)
		tenantID := s.CreateNamespace(t, WithOwner(userID))

		_, err := st.VaultSaveMeta(ctx, userID, tenantID, `{"m":1}`)
		require.NoError(t, err)

		require.NoError(t, st.VaultDelete(ctx, userID, tenantID))

		_, err = st.VaultGet(ctx, userID, tenantID)
		assert.ErrorIs(t, err, store.ErrNoDocuments)
	})
}
