package e2e_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type environment struct {
	baseURL  string
	repoRoot string
	db       *pgxpool.Pool
	client   *http.Client
}

type apiErrorResponse struct {
	Error     string `json:"error"`
	RequestID string `json:"requestId"`
}

type requestItem struct {
	SkuID                string `json:"skuId"`
	Quantity             int    `json:"quantity"`
	UnitPriceAmountMinor int    `json:"unitPriceAmountMinor"`
	Currency             string `json:"currency"`
}

type createBuyIntentRequest struct {
	BuyerID string        `json:"buyerId"`
	Items   []requestItem `json:"items"`
}

type acceptBuyIntentResponse struct {
	CommandID     string `json:"commandId"`
	CorrelationID string `json:"correlationId"`
	Status        string `json:"status"`
}

type commandStatusResponse struct {
	CommandID        string  `json:"commandId"`
	CorrelationID    string  `json:"correlationId"`
	Status           string  `json:"status"`
	CheckoutIntentID *string `json:"checkoutIntentId"`
	EventID          *string `json:"eventId"`
	IsDuplicate      bool    `json:"isDuplicate"`
	FailureCode      *string `json:"failureCode"`
	FailureMessage   *string `json:"failureMessage"`
	CreatedAt        string  `json:"createdAt"`
	UpdatedAt        string  `json:"updatedAt"`
}

type createCheckoutIntentRequest struct {
	BuyerID        string        `json:"buyerId"`
	Items          []requestItem `json:"items"`
	IdempotencyKey string        `json:"idempotencyKey,omitempty"`
}

type createCheckoutIntentResponse struct {
	CheckoutIntentID string `json:"checkoutIntentId"`
	EventID          string `json:"eventId"`
	Status           string `json:"status"`
	IdempotentReplay bool   `json:"idempotentReplay"`
}

type checkoutIntentResponse struct {
	CheckoutIntentID   string        `json:"checkoutIntentId"`
	BuyerID            string        `json:"buyerId"`
	Status             string        `json:"status"`
	Items              []requestItem `json:"items"`
	PaymentID          *string       `json:"paymentId"`
	OrderID            *string       `json:"orderId"`
	RejectionReason    *string       `json:"rejectionReason"`
	CancellationReason *string       `json:"cancellationReason"`
	AggregateVersion   int64         `json:"aggregateVersion"`
	LastEventID        int64         `json:"lastEventId"`
	UpdatedAt          string        `json:"updatedAt"`
}

type projectionProcessResponse struct {
	Locked          bool  `json:"locked"`
	ProcessedEvents int   `json:"processedEvents"`
	LastEventID     int64 `json:"lastEventId"`
}

type completeDemoCheckoutResponse struct {
	CheckoutIntentID string  `json:"checkoutIntentId"`
	Status           string  `json:"status"`
	OrderID          *string `json:"orderId"`
	PaymentID        *string `json:"paymentId"`
	Reason           *string `json:"reason"`
}

type seckillCommandResultRow struct {
	CommandID        string
	CheckoutIntentID *string
	Status           string
	FailureReason    *string
}

type catalogSeedItem struct {
	ProductID           string
	Name                string
	Description         string
	SkuID               string
	SkuCode             string
	PriceAmountMinor    int
	Currency            string
	OnHand              int
	SeckillCandidate    bool
	SeckillDefaultStock *int
	Attributes          map[string]any
}

var catalogSeed = []catalogSeedItem{
	{
		ProductID:           "limited-runner",
		Name:                "Limited Runner",
		Description:         "One hot SKU for high-concurrency direct buy pressure.",
		SkuID:               "sku_hot_001",
		SkuCode:             "hot-001",
		PriceAmountMinor:    100000,
		Currency:            "TWD",
		OnHand:              100,
		SeckillCandidate:    true,
		SeckillDefaultStock: intPtr(50),
		Attributes: map[string]any{
			"slug":          "limited-runner",
			"image":         "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1400&q=80",
			"image_alt":     "Red running shoe",
			"checkout_note": "one hot product · event-sourced checkout",
		},
	},
	{
		ProductID:        "everyday-tee",
		Name:             "Everyday Tee",
		Description:      "A steady catalog SKU used to verify mixed-cart checkout behavior.",
		SkuID:            "sku_tee_001",
		SkuCode:          "tee-001",
		PriceAmountMinor: 68000,
		Currency:         "TWD",
		OnHand:           240,
		SeckillCandidate: false,
		Attributes: map[string]any{
			"slug":          "everyday-tee",
			"image":         "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=1400&q=80",
			"image_alt":     "Folded neutral t-shirt",
			"checkout_note": "catalog product · multi-SKU cart ready",
		},
	},
	{
		ProductID:           "travel-cap",
		Name:                "Travel Cap",
		Description:         "A lightweight add-on SKU for cart checkout reservation progress.",
		SkuID:               "sku_cap_001",
		SkuCode:             "cap-001",
		PriceAmountMinor:    42000,
		Currency:            "TWD",
		OnHand:              160,
		SeckillCandidate:    true,
		SeckillDefaultStock: intPtr(40),
		Attributes: map[string]any{
			"slug":          "travel-cap",
			"image":         "https://images.unsplash.com/photo-1521369909029-2afed882baee?auto=format&fit=crop&w=1400&q=80",
			"image_alt":     "Casual travel cap",
			"checkout_note": "add-on product · projection-backed inventory",
		},
	},
}

func (e *environment) healthz(ctx context.Context) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.baseURL+"/healthz", nil)
	if err != nil {
		return 0, err
	}
	response, err := e.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	return response.StatusCode, nil
}

func (e *environment) applyMigrations(ctx context.Context) error {
	pattern := filepath.Join(e.repoRoot, "db", "migrations", "*.sql")
	files, err := filepath.Glob(pattern)
	if err != nil {
		return err
	}
	sort.Strings(files)

	for _, file := range files {
		contents, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		parts := strings.Split(string(contents), "--> statement-breakpoint")
		for _, part := range parts {
			statement := strings.TrimSpace(part)
			if statement == "" {
				continue
			}
			if _, err := e.db.Exec(ctx, statement); err != nil {
				return fmt.Errorf("apply migration %s: %w", filepath.Base(file), err)
			}
		}
	}
	return nil
}

func (e *environment) seedCatalog(ctx context.Context) error {
	for _, item := range catalogSeed {
		attributesJSON, err := json.Marshal(item.Attributes)
		if err != nil {
			return err
		}

		if _, err := e.db.Exec(ctx, `
      insert into product (product_id, name, description, status)
      values ($1, $2, $3, 'active')
      on conflict (product_id)
      do update set
        name = excluded.name,
        description = excluded.description,
        status = excluded.status,
        updated_at = now()
    `, item.ProductID, item.Name, item.Description); err != nil {
			return err
		}

		if _, err := e.db.Exec(ctx, `
      insert into sku (
        sku_id,
        product_id,
        sku_code,
        name,
        price_amount_minor,
        currency,
        status,
        seckill_candidate,
        seckill_enabled,
        seckill_stock_limit,
        seckill_default_stock,
        attributes
      )
      values ($1, $2, $3, $4, $5, $6, 'active', $7, false, null, $8, $9::jsonb)
      on conflict (sku_id)
      do update set
        product_id = excluded.product_id,
        sku_code = excluded.sku_code,
        name = excluded.name,
        price_amount_minor = excluded.price_amount_minor,
        currency = excluded.currency,
        status = excluded.status,
        seckill_candidate = excluded.seckill_candidate,
        seckill_enabled = false,
        seckill_stock_limit = null,
        seckill_default_stock = excluded.seckill_default_stock,
        attributes = excluded.attributes,
        updated_at = now()
    `, item.SkuID, item.ProductID, item.SkuCode, item.Name, item.PriceAmountMinor, item.Currency, item.SeckillCandidate, item.SeckillDefaultStock, string(attributesJSON)); err != nil {
			return err
		}

		if _, err := e.db.Exec(ctx, `
      insert into sku_inventory_projection (
        sku_id,
        aggregate_version,
        last_event_id,
        on_hand,
        reserved,
        sold,
        available
      )
      values ($1, 0, 0, $2, 0, 0, $2)
      on conflict (sku_id)
      do update set
        aggregate_version = 0,
        last_event_id = 0,
        on_hand = excluded.on_hand,
        reserved = 0,
        sold = 0,
        available = excluded.available,
        updated_at = now()
    `, item.SkuID, item.OnHand); err != nil {
			return err
		}
	}
	return nil
}

func (e *environment) resetBusinessState(ctx context.Context) error {
	_, err := e.db.Exec(ctx, `
    truncate table
      staged_buy_intent_command,
      command_status,
      seckill_command_result,
      checkout_intent_projection,
      order_projection,
      projection_checkpoint,
      event_store
    restart identity
  `)
	return err
}

func (e *environment) enableSeckill(ctx context.Context, skuID string, stockLimit int, onHand int) error {
	if _, err := e.db.Exec(ctx, `
    update sku
    set
      seckill_enabled = true,
      seckill_stock_limit = $2,
      updated_at = now()
    where sku_id = $1
  `, skuID, stockLimit); err != nil {
		return err
	}
	_, err := e.db.Exec(ctx, `
    update sku_inventory_projection
    set
      aggregate_version = 0,
      last_event_id = 0,
      on_hand = $2,
      reserved = 0,
      sold = 0,
      available = $2,
      updated_at = now()
    where sku_id = $1
  `, skuID, onHand)
	return err
}

func (e *environment) requestJSON(ctx context.Context, method, path string, payload any) (int, []byte, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return 0, nil, err
		}
		body = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, e.baseURL+path, body)
	if err != nil {
		return 0, nil, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	response, err := e.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return 0, nil, err
	}
	return response.StatusCode, responseBody, nil
}

func (e *environment) requestJSONWithHeaders(ctx context.Context, method, path string, payload any, headers map[string]string) (int, []byte, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return 0, nil, err
		}
		body = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, e.baseURL+path, body)
	if err != nil {
		return 0, nil, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	response, err := e.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return 0, nil, err
	}
	return response.StatusCode, responseBody, nil
}

func (e *environment) processProjections(ctx context.Context) (int, projectionProcessResponse, error) {
	status, body, err := e.requestJSON(ctx, http.MethodPost, "/api/internal/projections/process", map[string]any{
		"projectionName": "main",
		"batchSize":      100,
	})
	if err != nil {
		return 0, projectionProcessResponse{}, err
	}
	if status == http.StatusConflict {
		return status, projectionProcessResponse{Locked: false}, nil
	}
	if status != http.StatusOK {
		apiError := apiErrorResponse{}
		if err := json.Unmarshal(body, &apiError); err == nil && apiError.Error != "" {
			return status, projectionProcessResponse{}, fmt.Errorf("process projections: %s", apiError.Error)
		}
		return status, projectionProcessResponse{}, fmt.Errorf("process projections: unexpected status %d", status)
	}

	result := projectionProcessResponse{}
	if err := json.Unmarshal(body, &result); err != nil {
		return 0, projectionProcessResponse{}, err
	}
	return status, result, nil
}

func (e *environment) readCommandStatus(ctx context.Context, commandID string) (int, commandStatusResponse, apiErrorResponse, error) {
	status, body, err := e.requestJSON(ctx, http.MethodGet, "/api/buy-intent-commands/"+commandID, nil)
	if err != nil {
		return 0, commandStatusResponse{}, apiErrorResponse{}, err
	}
	if status >= 400 {
		apiError := apiErrorResponse{}
		_ = json.Unmarshal(body, &apiError)
		return status, commandStatusResponse{}, apiError, nil
	}
	result := commandStatusResponse{}
	err = json.Unmarshal(body, &result)
	return status, result, apiErrorResponse{}, err
}

func (e *environment) readCheckoutIntent(ctx context.Context, checkoutIntentID string) (int, checkoutIntentResponse, apiErrorResponse, error) {
	status, body, err := e.requestJSON(ctx, http.MethodGet, "/api/checkout-intents/"+checkoutIntentID, nil)
	if err != nil {
		return 0, checkoutIntentResponse{}, apiErrorResponse{}, err
	}
	if status >= 400 {
		apiError := apiErrorResponse{}
		_ = json.Unmarshal(body, &apiError)
		return status, checkoutIntentResponse{}, apiError, nil
	}
	result := checkoutIntentResponse{}
	err = json.Unmarshal(body, &result)
	return status, result, apiErrorResponse{}, err
}

func (e *environment) queryCheckoutEventCount(ctx context.Context) (int, error) {
	var count int
	err := e.db.QueryRow(ctx, `select count(*) from event_store where aggregate_type = 'checkout'`).Scan(&count)
	return count, err
}

func (e *environment) readSeckillCommandResult(ctx context.Context, commandID string) (seckillCommandResultRow, error) {
	row := seckillCommandResultRow{}
	err := e.db.QueryRow(ctx, `
    select command_id, checkout_intent_id, status, failure_reason
    from seckill_command_result
    where command_id = $1
    limit 1
  `, commandID).Scan(&row.CommandID, &row.CheckoutIntentID, &row.Status, &row.FailureReason)
	return row, err
}

func intPtr(value int) *int {
	return &value
}
