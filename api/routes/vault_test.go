package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/shellhub-io/shellhub/api/services"
	servicemock "github.com/shellhub-io/shellhub/api/services/mocks"
	"github.com/shellhub-io/shellhub/pkg/api/requests"
	"github.com/shellhub-io/shellhub/pkg/api/responses"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

const (
	vaultTestUserID   = "00000000-0000-4000-0000-000000000000"
	vaultTestTenantID = "10000000-0000-4000-0000-000000000000"
)

func vaultUserHeaders() map[string]string {
	return map[string]string{
		"Content-Type": "application/json",
		"X-ID":         vaultTestUserID,
		"X-Tenant-ID":  vaultTestTenantID,
		"X-Role":       "owner",
	}
}

func TestGetVaultRoute(t *testing.T) {
	type Expected struct {
		body   *responses.Vault
		status int
	}

	svcMock := servicemock.NewMockService(t)

	cases := []struct {
		description   string
		headers       map[string]string
		requiredMocks func()
		expected      Expected
	}{
		{
			description: "fails when authenticated with an api key",
			headers: map[string]string{
				"Content-Type": "application/json",
				"X-API-Key":    "b2f7cc0e-d933-4aad-9ab2-b557f2f2554f",
				"X-Tenant-ID":  vaultTestTenantID,
			},
			requiredMocks: func() {},
			expected:      Expected{body: nil, status: http.StatusForbidden},
		},
		{
			description:   "returns 404 when the vault does not exist",
			headers:       vaultUserHeaders(),
			requiredMocks: func() {
				svcMock.
					On("GetVault", mock.Anything, &requests.VaultGet{UserID: vaultTestUserID, TenantID: vaultTestTenantID}).
					Return(nil, services.NewErrVaultNotFound(vaultTestTenantID, nil)).
					Once()
			},
			expected: Expected{body: nil, status: http.StatusNotFound},
		},
		{
			description: "succeeds",
			headers:     vaultUserHeaders(),
			requiredMocks: func() {
				svcMock.
					On("GetVault", mock.Anything, &requests.VaultGet{UserID: vaultTestUserID, TenantID: vaultTestTenantID}).
					Return(&responses.Vault{Meta: `{"m":1}`, Version: 2}, nil).
					Once()
			},
			expected: Expected{body: &responses.Vault{Meta: `{"m":1}`, Version: 2}, status: http.StatusOK},
		},
	}

	for _, tc := range cases {
		t.Run(tc.description, func(t *testing.T) {
			tc.requiredMocks()

			req := httptest.NewRequest(http.MethodGet, "/api/vault", nil)
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}

			rec := httptest.NewRecorder()
			e := NewRouter(svcMock)
			e.ServeHTTP(rec, req)

			require.Equal(t, tc.expected.status, rec.Result().StatusCode)
			if tc.expected.body != nil {
				body := new(responses.Vault)
				require.NoError(t, json.NewDecoder(rec.Body).Decode(body))
				require.Equal(t, tc.expected.body, body)
			}
		})
	}
}

func TestSaveVaultMetaRoute(t *testing.T) {
	type Expected struct {
		body   *responses.VaultVersion
		status int
	}

	svcMock := servicemock.NewMockService(t)

	cases := []struct {
		description   string
		headers       map[string]string
		body          map[string]interface{}
		requiredMocks func()
		expected      Expected
	}{
		{
			description:   "fails validation when meta is empty",
			headers:       vaultUserHeaders(),
			body:          map[string]interface{}{"meta": ""},
			requiredMocks: func() {},
			expected:      Expected{body: nil, status: http.StatusBadRequest},
		},
		{
			description:   "fails validation when meta exceeds the max length",
			headers:       vaultUserHeaders(),
			body:          map[string]interface{}{"meta": strings.Repeat("a", 4097)},
			requiredMocks: func() {},
			expected:      Expected{body: nil, status: http.StatusBadRequest},
		},
		{
			description: "succeeds",
			headers:     vaultUserHeaders(),
			body:        map[string]interface{}{"meta": `{"version":1}`},
			requiredMocks: func() {
				svcMock.
					On("SaveVaultMeta", mock.Anything, &requests.SaveVaultMeta{UserID: vaultTestUserID, TenantID: vaultTestTenantID, Meta: `{"version":1}`}).
					Return(&responses.VaultVersion{Version: 1}, nil).
					Once()
			},
			expected: Expected{body: &responses.VaultVersion{Version: 1}, status: http.StatusOK},
		},
	}

	for _, tc := range cases {
		t.Run(tc.description, func(t *testing.T) {
			tc.requiredMocks()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPut, "/api/vault/meta", strings.NewReader(string(data)))
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}

			rec := httptest.NewRecorder()
			e := NewRouter(svcMock)
			e.ServeHTTP(rec, req)

			require.Equal(t, tc.expected.status, rec.Result().StatusCode)
			if tc.expected.body != nil {
				body := new(responses.VaultVersion)
				require.NoError(t, json.NewDecoder(rec.Body).Decode(body))
				require.Equal(t, tc.expected.body, body)
			}
		})
	}
}

func TestSaveVaultDataRoute(t *testing.T) {
	type Expected struct {
		body   *responses.VaultVersion
		status int
	}

	svcMock := servicemock.NewMockService(t)

	cases := []struct {
		description   string
		headers       map[string]string
		body          map[string]interface{}
		requiredMocks func()
		expected      Expected
	}{
		{
			description:   "fails validation when version is missing",
			headers:       vaultUserHeaders(),
			body:          map[string]interface{}{"data": `{"iv":"x"}`},
			requiredMocks: func() {},
			expected:      Expected{body: nil, status: http.StatusBadRequest},
		},
		{
			description: "returns 409 when the version is stale",
			headers:     vaultUserHeaders(),
			body:        map[string]interface{}{"data": `{"iv":"x"}`, "version": 2},
			requiredMocks: func() {
				svcMock.
					On("SaveVaultData", mock.Anything, &requests.SaveVaultData{UserID: vaultTestUserID, TenantID: vaultTestTenantID, Data: `{"iv":"x"}`, Version: 2}).
					Return(nil, services.NewErrVaultConflict(nil)).
					Once()
			},
			expected: Expected{body: nil, status: http.StatusConflict},
		},
		{
			description: "succeeds",
			headers:     vaultUserHeaders(),
			body:        map[string]interface{}{"data": `{"iv":"x"}`, "version": 1},
			requiredMocks: func() {
				svcMock.
					On("SaveVaultData", mock.Anything, &requests.SaveVaultData{UserID: vaultTestUserID, TenantID: vaultTestTenantID, Data: `{"iv":"x"}`, Version: 1}).
					Return(&responses.VaultVersion{Version: 2}, nil).
					Once()
			},
			expected: Expected{body: &responses.VaultVersion{Version: 2}, status: http.StatusOK},
		},
	}

	for _, tc := range cases {
		t.Run(tc.description, func(t *testing.T) {
			tc.requiredMocks()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPut, "/api/vault/data", strings.NewReader(string(data)))
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}

			rec := httptest.NewRecorder()
			e := NewRouter(svcMock)
			e.ServeHTTP(rec, req)

			require.Equal(t, tc.expected.status, rec.Result().StatusCode)
			if tc.expected.body != nil {
				body := new(responses.VaultVersion)
				require.NoError(t, json.NewDecoder(rec.Body).Decode(body))
				require.Equal(t, tc.expected.body, body)
			}
		})
	}
}

func TestDeleteVaultRoute(t *testing.T) {
	svcMock := servicemock.NewMockService(t)

	t.Run("succeeds", func(t *testing.T) {
		svcMock.
			On("DeleteVault", mock.Anything, &requests.VaultDelete{UserID: vaultTestUserID, TenantID: vaultTestTenantID}).
			Return(nil).
			Once()

		req := httptest.NewRequest(http.MethodDelete, "/api/vault", nil)
		for k, v := range vaultUserHeaders() {
			req.Header.Set(k, v)
		}

		rec := httptest.NewRecorder()
		e := NewRouter(svcMock)
		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Result().StatusCode)
	})
}
