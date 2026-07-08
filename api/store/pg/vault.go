package pg

import (
	"context"

	"github.com/shellhub-io/shellhub/api/store"
	"github.com/shellhub-io/shellhub/api/store/pg/entity"
	"github.com/shellhub-io/shellhub/pkg/clock"
	"github.com/shellhub-io/shellhub/pkg/models"
)

func (pg *Pg) VaultGet(ctx context.Context, userID, tenantID string) (*models.Vault, error) {
	db := pg.GetConnection(ctx)

	v := new(entity.Vault)
	if err := db.NewSelect().
		Model(v).
		Where("user_id = ?", userID).
		Where("namespace_id = ?", tenantID).
		Scan(ctx); err != nil {
		return nil, fromSQLError(err)
	}

	return entity.VaultToModel(v), nil
}

func (pg *Pg) VaultSaveMeta(ctx context.Context, userID, tenantID, meta string) (*models.Vault, error) {
	return pg.vaultUpsert(ctx, userID, tenantID, "meta", meta)
}

func (pg *Pg) VaultSaveSettings(ctx context.Context, userID, tenantID, settings string) (*models.Vault, error) {
	return pg.vaultUpsert(ctx, userID, tenantID, "settings", settings)
}

// vaultUpsert creates the vault at version 1 when it does not exist yet or updates the
// given column and bumps the version otherwise. column is a trusted internal constant, so
// its set clause is never derived from user input. Within ON CONFLICT DO UPDATE an
// unqualified column reference (version) resolves to the existing row, which is what the
// increment relies on.
func (pg *Pg) vaultUpsert(ctx context.Context, userID, tenantID, column, value string) (*models.Vault, error) {
	db := pg.GetConnection(ctx)

	now := clock.Now()
	e := &entity.Vault{
		UserID:      userID,
		NamespaceID: tenantID,
		Version:     1,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	var setClause string
	switch column {
	case "meta":
		e.Meta = value
		setClause = "meta = EXCLUDED.meta"
	case "settings":
		e.Settings = value
		setClause = "settings = EXCLUDED.settings"
	default:
		return nil, store.ErrResolverNotFound
	}

	var result entity.Vault
	if err := db.NewInsert().
		Model(e).
		On("CONFLICT (user_id, namespace_id) DO UPDATE").
		Set(setClause).
		Set("version = version + 1").
		Set("updated_at = EXCLUDED.updated_at").
		Returning("*").
		Scan(ctx, &result); err != nil {
		return nil, fromSQLError(err)
	}

	return entity.VaultToModel(&result), nil
}

func (pg *Pg) VaultSaveData(ctx context.Context, userID, tenantID, data string, version uint64) (*models.Vault, error) {
	db := pg.GetConnection(ctx)

	// Atomic compare-and-swap: the write only lands when the stored version still equals
	// the version the caller last saw. This is the optimistic-concurrency guard.
	res, err := db.NewUpdate().
		Model((*entity.Vault)(nil)).
		Set("data = ?", data).
		Set("version = version + 1").
		Set("updated_at = ?", clock.Now()).
		Where("user_id = ?", userID).
		Where("namespace_id = ?", tenantID).
		Where("version = ?", version).
		Exec(ctx)
	if err != nil {
		return nil, fromSQLError(err)
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return nil, fromSQLError(err)
	}

	if rows == 0 {
		// The CAS matched no row: either the vault does not exist (404) or the caller's
		// version is stale (409). A follow-up existence check tells the two apart.
		exists, err := db.NewSelect().
			Model((*entity.Vault)(nil)).
			Where("user_id = ?", userID).
			Where("namespace_id = ?", tenantID).
			Exists(ctx)
		if err != nil {
			return nil, fromSQLError(err)
		}

		if exists {
			return nil, store.ErrDuplicate
		}

		return nil, store.ErrNoDocuments
	}

	return pg.VaultGet(ctx, userID, tenantID)
}

func (pg *Pg) VaultDelete(ctx context.Context, userID, tenantID string) error {
	db := pg.GetConnection(ctx)

	res, err := db.NewDelete().
		Model((*entity.Vault)(nil)).
		Where("user_id = ?", userID).
		Where("namespace_id = ?", tenantID).
		Exec(ctx)
	if err != nil {
		return fromSQLError(err)
	}

	if rows, err := res.RowsAffected(); err != nil || rows == 0 {
		return store.ErrNoDocuments
	}

	return nil
}
