package routes

import (
	"net/http"

	"github.com/shellhub-io/shellhub/api/pkg/gateway"
	"github.com/shellhub-io/shellhub/pkg/api/requests"
)

const (
	GetVaultURL          = "/vault"
	DeleteVaultURL       = "/vault"
	SaveVaultMetaURL     = "/vault/meta"
	SaveVaultDataURL     = "/vault/data"
	SaveVaultSettingsURL = "/vault/settings"
)

func (h *Handler) GetVault(c gateway.Context) error {
	req := new(requests.VaultGet)

	if err := c.Bind(req); err != nil {
		return err
	}

	if err := c.Validate(req); err != nil {
		return err
	}

	res, err := h.service.GetVault(c.Ctx(), req)
	if err != nil {
		return err
	}

	return c.JSON(http.StatusOK, res)
}

func (h *Handler) SaveVaultMeta(c gateway.Context) error {
	req := new(requests.SaveVaultMeta)

	if err := c.Bind(req); err != nil {
		return err
	}

	if err := c.Validate(req); err != nil {
		return err
	}

	res, err := h.service.SaveVaultMeta(c.Ctx(), req)
	if err != nil {
		return err
	}

	return c.JSON(http.StatusOK, res)
}

func (h *Handler) SaveVaultData(c gateway.Context) error {
	req := new(requests.SaveVaultData)

	if err := c.Bind(req); err != nil {
		return err
	}

	if err := c.Validate(req); err != nil {
		return err
	}

	res, err := h.service.SaveVaultData(c.Ctx(), req)
	if err != nil {
		return err
	}

	return c.JSON(http.StatusOK, res)
}

func (h *Handler) SaveVaultSettings(c gateway.Context) error {
	req := new(requests.SaveVaultSettings)

	if err := c.Bind(req); err != nil {
		return err
	}

	if err := c.Validate(req); err != nil {
		return err
	}

	res, err := h.service.SaveVaultSettings(c.Ctx(), req)
	if err != nil {
		return err
	}

	return c.JSON(http.StatusOK, res)
}

func (h *Handler) DeleteVault(c gateway.Context) error {
	req := new(requests.VaultDelete)

	if err := c.Bind(req); err != nil {
		return err
	}

	if err := c.Validate(req); err != nil {
		return err
	}

	if err := h.service.DeleteVault(c.Ctx(), req); err != nil {
		return err
	}

	return c.NoContent(http.StatusOK)
}
