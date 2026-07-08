package entity

import (
	"time"

	"github.com/shellhub-io/shellhub/pkg/models"
	"github.com/uptrace/bun"
)

type Vault struct {
	bun.BaseModel `bun:"table:vaults"`

	UserID      string    `bun:"user_id,pk,type:uuid"`
	NamespaceID string    `bun:"namespace_id,pk,type:uuid"`
	Meta        string    `bun:"meta"`
	Data        string    `bun:"data"`
	Settings    string    `bun:"settings"`
	Version     uint64    `bun:"version"`
	CreatedAt   time.Time `bun:"created_at"`
	UpdatedAt   time.Time `bun:"updated_at"`
}

func VaultFromModel(model *models.Vault) *Vault {
	return &Vault{
		UserID:      model.UserID,
		NamespaceID: model.TenantID,
		Meta:        model.Meta,
		Data:        model.Data,
		Settings:    model.Settings,
		Version:     model.Version,
		CreatedAt:   model.CreatedAt,
		UpdatedAt:   model.UpdatedAt,
	}
}

func VaultToModel(entity *Vault) *models.Vault {
	return &models.Vault{
		UserID:    entity.UserID,
		TenantID:  entity.NamespaceID,
		Meta:      entity.Meta,
		Data:      entity.Data,
		Settings:  entity.Settings,
		Version:   entity.Version,
		CreatedAt: entity.CreatedAt.UTC(),
		UpdatedAt: entity.UpdatedAt.UTC(),
	}
}
