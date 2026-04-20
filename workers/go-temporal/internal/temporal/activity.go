package temporal

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"minishop/workers/go-temporal/internal/contracts"
)

type CheckoutCompletionActivities struct {
	pool   *pgxpool.Pool
	logger *zap.Logger
}

type StartCheckoutInput struct {
	CommandID        string
	CorrelationID    string
	CheckoutIntentID string
}

type StartCheckoutResult struct {
	CheckoutStatus  string   `json:"checkoutStatus"`
	PaymentID       string   `json:"paymentId,omitempty"`
	ReservationIDs  []string `json:"reservationIds,omitempty"`
	RejectionReason string   `json:"rejectionReason,omitempty"`
}

type CompletePaymentInput struct {
	CommandID         string
	CheckoutIntentID  string
	PaymentID         string
	ProviderReference string
}

type CompletePaymentResult struct {
	CheckoutStatus string `json:"checkoutStatus"`
	OrderID        string `json:"orderId"`
	PaymentID      string `json:"paymentId"`
}

type FailPaymentInput struct {
	CommandID        string
	CheckoutIntentID string
	PaymentID        string
	Reason           string
}

type FailPaymentResult struct {
	CheckoutStatus string `json:"checkoutStatus"`
	Reason         string `json:"reason"`
}

type checkoutIntentCreatedPayload struct {
	CheckoutIntentID string                   `json:"checkout_intent_id"`
	BuyerID          string                   `json:"buyer_id"`
	Items            []contracts.CheckoutItem `json:"items"`
	IdempotencyKey   string                   `json:"idempotency_key,omitempty"`
}

type inventoryReservedPayload struct {
	CheckoutIntentID string `json:"checkout_intent_id"`
	ReservationID    string `json:"reservation_id"`
	SKUID            string `json:"sku_id"`
	Quantity         int    `json:"quantity"`
	ExpiresAt        string `json:"expires_at"`
}

type inventoryReservationRejectedPayload struct {
	CheckoutIntentID string `json:"checkout_intent_id"`
	ReservationID    string `json:"reservation_id"`
	SKUID            string `json:"sku_id"`
	Quantity         int    `json:"quantity"`
	Reason           string `json:"reason"`
}

type inventoryReservationReleasedPayload struct {
	CheckoutIntentID string `json:"checkout_intent_id"`
	ReservationID    string `json:"reservation_id"`
	SKUID            string `json:"sku_id"`
	Quantity         int    `json:"quantity"`
	Reason           string `json:"reason"`
}

type paymentRequestedPayload struct {
	PaymentID        string `json:"payment_id"`
	CheckoutIntentID string `json:"checkout_intent_id"`
	Amount           int    `json:"amount"`
	IdempotencyKey   string `json:"idempotency_key"`
}

type paymentSucceededPayload struct {
	PaymentID         string `json:"payment_id"`
	CheckoutIntentID  string `json:"checkout_intent_id"`
	ProviderReference string `json:"provider_reference"`
}

type paymentFailedPayload struct {
	PaymentID        string `json:"payment_id"`
	CheckoutIntentID string `json:"checkout_intent_id"`
	Reason           string `json:"reason"`
}

type orderConfirmedPayload struct {
	OrderID          string                   `json:"order_id"`
	CheckoutIntentID string                   `json:"checkout_intent_id"`
	BuyerID          string                   `json:"buyer_id"`
	Items            []contracts.CheckoutItem `json:"items"`
	TotalAmountMinor int                      `json:"total_amount_minor"`
}

type eventRecord struct {
	EventType string
	Payload   []byte
}

func NewCheckoutCompletionActivities(pool *pgxpool.Pool, logger *zap.Logger) *CheckoutCompletionActivities {
	return &CheckoutCompletionActivities{pool: pool, logger: logger}
}

func (a *CheckoutCompletionActivities) StartCheckout(ctx context.Context, input StartCheckoutInput) (StartCheckoutResult, error) {
	checkout, err := a.loadCheckoutIntent(ctx, input.CheckoutIntentID)
	if err != nil {
		return StartCheckoutResult{}, err
	}

	reservationIDs := make([]string, 0, len(checkout.Items))
	for index, item := range checkout.Items {
		onHand, err := a.loadSkuOnHand(ctx, item.SKUID)
		if err != nil {
			return StartCheckoutResult{}, err
		}

		reservationID, rejected, err := a.reserveInventory(ctx, checkout.CheckoutIntentID, item, onHand, index)
		if err != nil {
			return StartCheckoutResult{}, err
		}
		if rejected != nil {
			return StartCheckoutResult{
				CheckoutStatus:  "rejected",
				RejectionReason: rejected.Reason,
			}, nil
		}
		reservationIDs = append(reservationIDs, reservationID)
	}

	paymentID := uuid.NewString()
	totalAmountMinor := totalAmount(checkout.Items)
	if err := a.appendPaymentRequested(ctx, paymentID, checkout.CheckoutIntentID, totalAmountMinor); err != nil {
		return StartCheckoutResult{}, err
	}

	a.logger.Info(
		"checkout_started_pending_payment",
		zap.String("command_id", input.CommandID),
		zap.String("checkout_intent_id", input.CheckoutIntentID),
		zap.String("payment_id", paymentID),
	)

	return StartCheckoutResult{
		CheckoutStatus: "pending_payment",
		PaymentID:      paymentID,
		ReservationIDs: reservationIDs,
	}, nil
}

func (a *CheckoutCompletionActivities) CompletePayment(ctx context.Context, input CompletePaymentInput) (CompletePaymentResult, error) {
	checkout, err := a.loadCheckoutIntent(ctx, input.CheckoutIntentID)
	if err != nil {
		return CompletePaymentResult{}, err
	}

	if err := a.appendPaymentSucceeded(ctx, input.PaymentID, input.CheckoutIntentID, input.ProviderReference); err != nil {
		return CompletePaymentResult{}, err
	}

	orderID := uuid.NewString()
	if err := a.appendOrderConfirmed(ctx, orderID, checkout); err != nil {
		return CompletePaymentResult{}, err
	}

	a.logger.Info(
		"checkout_payment_confirmed",
		zap.String("command_id", input.CommandID),
		zap.String("checkout_intent_id", input.CheckoutIntentID),
		zap.String("payment_id", input.PaymentID),
		zap.String("order_id", orderID),
	)

	return CompletePaymentResult{
		CheckoutStatus: "confirmed",
		OrderID:        orderID,
		PaymentID:      input.PaymentID,
	}, nil
}

func (a *CheckoutCompletionActivities) FailPayment(ctx context.Context, input FailPaymentInput) (FailPaymentResult, error) {
	if err := a.appendPaymentFailed(ctx, input.PaymentID, input.CheckoutIntentID, input.Reason); err != nil {
		return FailPaymentResult{}, err
	}

	reservations, err := a.loadReservedInventory(ctx, input.CheckoutIntentID)
	if err != nil {
		return FailPaymentResult{}, err
	}

	for _, reservation := range reservations {
		if err := a.appendInventoryRelease(ctx, reservation, input.Reason); err != nil {
			return FailPaymentResult{}, err
		}
	}

	status := "cancelled"
	if input.Reason == "payment_timeout" {
		status = "expired"
	}

	a.logger.Info(
		"checkout_payment_failed",
		zap.String("command_id", input.CommandID),
		zap.String("checkout_intent_id", input.CheckoutIntentID),
		zap.String("payment_id", input.PaymentID),
		zap.String("reason", input.Reason),
	)

	return FailPaymentResult{
		CheckoutStatus: status,
		Reason:         input.Reason,
	}, nil
}

func (a *CheckoutCompletionActivities) loadCheckoutIntent(ctx context.Context, checkoutIntentID string) (checkoutIntentCreatedPayload, error) {
	row := a.pool.QueryRow(ctx, `
		select payload
		from event_store
		where aggregate_type = 'checkout'
		  and aggregate_id = $1
		  and event_type = 'CheckoutIntentCreated'
		order by aggregate_version asc
		limit 1
	`, checkoutIntentID)

	var payload []byte
	if err := row.Scan(&payload); err != nil {
		return checkoutIntentCreatedPayload{}, err
	}

	var result checkoutIntentCreatedPayload
	if err := json.Unmarshal(payload, &result); err != nil {
		return checkoutIntentCreatedPayload{}, err
	}

	return result, nil
}

func (a *CheckoutCompletionActivities) loadSkuOnHand(ctx context.Context, skuID string) (int, error) {
	row := a.pool.QueryRow(ctx, `
		select on_hand
		from sku_inventory_projection
		where sku_id = $1
		limit 1
	`, skuID)

	var onHand int32
	if err := row.Scan(&onHand); err != nil {
		return 0, err
	}

	return int(onHand), nil
}

func (a *CheckoutCompletionActivities) reserveInventory(ctx context.Context, checkoutIntentID string, item contracts.CheckoutItem, onHand, index int) (string, *FailPaymentResult, error) {
	priorEvents, err := a.loadAggregateEvents(ctx, "sku", item.SKUID)
	if err != nil {
		return "", nil, err
	}

	available := onHand
	for _, event := range priorEvents {
		switch event.EventType {
		case "InventoryReserved":
			var payload inventoryReservedPayload
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				return "", nil, err
			}
			available -= payload.Quantity
		case "InventoryReservationReleased":
			var payload inventoryReservationReleasedPayload
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				return "", nil, err
			}
			available += payload.Quantity
		}
	}

	reservationID := uuid.NewString()
	idempotencyKey := fmt.Sprintf("demo-reserve:%s:%d", checkoutIntentID, index)
	version := int64(len(priorEvents) + 1)

	if available < item.Quantity {
		_, err := a.appendEvent(
			ctx,
			"sku",
			item.SKUID,
			"InventoryReservationRejected",
			inventoryReservationRejectedPayload{
				CheckoutIntentID: checkoutIntentID,
				ReservationID:    reservationID,
				SKUID:            item.SKUID,
				Quantity:         item.Quantity,
				Reason:           "insufficient_inventory",
			},
			idempotencyKey,
			version,
		)
		if err != nil {
			return "", nil, err
		}
		return "", &FailPaymentResult{CheckoutStatus: "rejected", Reason: "insufficient_inventory"}, nil
	}

	if _, err := a.appendEvent(
		ctx,
		"sku",
		item.SKUID,
		"InventoryReserved",
		inventoryReservedPayload{
			CheckoutIntentID: checkoutIntentID,
			ReservationID:    reservationID,
			SKUID:            item.SKUID,
			Quantity:         item.Quantity,
			ExpiresAt:        time.Now().UTC().Add(15 * time.Minute).Format(time.RFC3339),
		},
		idempotencyKey,
		version,
	); err != nil {
		return "", nil, err
	}

	return reservationID, nil, nil
}

func (a *CheckoutCompletionActivities) appendPaymentRequested(ctx context.Context, paymentID, checkoutIntentID string, amount int) error {
	_, err := a.appendEvent(
		ctx,
		"payment",
		paymentID,
		"PaymentRequested",
		paymentRequestedPayload{
			PaymentID:        paymentID,
			CheckoutIntentID: checkoutIntentID,
			Amount:           amount,
			IdempotencyKey:   fmt.Sprintf("demo-payment:%s", checkoutIntentID),
		},
		fmt.Sprintf("demo-payment:%s", checkoutIntentID),
		1,
	)
	return err
}

func (a *CheckoutCompletionActivities) appendPaymentSucceeded(ctx context.Context, paymentID, checkoutIntentID, providerReference string) error {
	_, err := a.appendEvent(
		ctx,
		"payment",
		paymentID,
		"PaymentSucceeded",
		paymentSucceededPayload{
			PaymentID:         paymentID,
			CheckoutIntentID:  checkoutIntentID,
			ProviderReference: providerReference,
		},
		fmt.Sprintf("demo-payment-succeeded:%s", paymentID),
		2,
	)
	return err
}

func (a *CheckoutCompletionActivities) appendPaymentFailed(ctx context.Context, paymentID, checkoutIntentID, reason string) error {
	_, err := a.appendEvent(
		ctx,
		"payment",
		paymentID,
		"PaymentFailed",
		paymentFailedPayload{
			PaymentID:        paymentID,
			CheckoutIntentID: checkoutIntentID,
			Reason:           reason,
		},
		fmt.Sprintf("demo-payment-failed:%s", paymentID),
		2,
	)
	return err
}

func (a *CheckoutCompletionActivities) appendOrderConfirmed(ctx context.Context, orderID string, checkout checkoutIntentCreatedPayload) error {
	_, err := a.appendEvent(
		ctx,
		"order",
		orderID,
		"OrderConfirmed",
		orderConfirmedPayload{
			OrderID:          orderID,
			CheckoutIntentID: checkout.CheckoutIntentID,
			BuyerID:          checkout.BuyerID,
			Items:            checkout.Items,
			TotalAmountMinor: totalAmount(checkout.Items),
		},
		fmt.Sprintf("demo-order:%s", checkout.CheckoutIntentID),
		1,
	)
	return err
}

func (a *CheckoutCompletionActivities) appendInventoryRelease(ctx context.Context, reservation inventoryReservedPayload, reason string) error {
	version, err := nextAggregateVersion(ctx, a.pool, "sku", reservation.SKUID)
	if err != nil {
		return err
	}

	_, err = a.appendEvent(
		ctx,
		"sku",
		reservation.SKUID,
		"InventoryReservationReleased",
		inventoryReservationReleasedPayload{
			CheckoutIntentID: reservation.CheckoutIntentID,
			ReservationID:    reservation.ReservationID,
			SKUID:            reservation.SKUID,
			Quantity:         reservation.Quantity,
			Reason:           reason,
		},
		fmt.Sprintf("demo-release:%s:%s:%s", reservation.CheckoutIntentID, reservation.ReservationID, reason),
		version,
	)
	return err
}

func (a *CheckoutCompletionActivities) loadReservedInventory(ctx context.Context, checkoutIntentID string) ([]inventoryReservedPayload, error) {
	rows, err := a.pool.Query(ctx, `
		select event_type, payload
		from event_store
		where aggregate_type = 'sku'
		  and event_type in ('InventoryReserved', 'InventoryReservationReleased')
		  and payload ->> 'checkout_intent_id' = $1
		order by id asc
	`, checkoutIntentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	activeReservations := make(map[string]inventoryReservedPayload)
	for rows.Next() {
		var eventType string
		var payload []byte
		if err := rows.Scan(&eventType, &payload); err != nil {
			return nil, err
		}

		switch eventType {
		case "InventoryReserved":
			var reservation inventoryReservedPayload
			if err := json.Unmarshal(payload, &reservation); err != nil {
				return nil, err
			}
			activeReservations[reservation.ReservationID] = reservation
		case "InventoryReservationReleased":
			var release inventoryReservationReleasedPayload
			if err := json.Unmarshal(payload, &release); err != nil {
				return nil, err
			}
			delete(activeReservations, release.ReservationID)
		}
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	reservations := make([]inventoryReservedPayload, 0, len(activeReservations))
	for _, reservation := range activeReservations {
		reservations = append(reservations, reservation)
	}

	sort.Slice(reservations, func(i, j int) bool {
		return reservations[i].ReservationID < reservations[j].ReservationID
	})

	return reservations, nil
}

func (a *CheckoutCompletionActivities) loadAggregateEvents(ctx context.Context, aggregateType, aggregateID string) ([]eventRecord, error) {
	rows, err := a.pool.Query(ctx, `
		select event_type, payload
		from event_store
		where aggregate_type = $1
		  and aggregate_id = $2
		order by aggregate_version asc
	`, aggregateType, aggregateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []eventRecord
	for rows.Next() {
		var event eventRecord
		if err := rows.Scan(&event.EventType, &event.Payload); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (a *CheckoutCompletionActivities) appendEvent(
	ctx context.Context,
	aggregateType string,
	aggregateID string,
	eventType string,
	payload any,
	idempotencyKey string,
	aggregateVersion int64,
) (eventRecord, error) {
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return eventRecord{}, err
	}

	metadataJSON, err := json.Marshal(contracts.EventMetadata{
		RequestID: uuid.NewString(),
		TraceID:   uuid.NewString(),
		Source:    "worker",
		ActorID:   "go-temporal-checkout",
	})
	if err != nil {
		return eventRecord{}, err
	}

	eventID := uuid.New()
	row := a.pool.QueryRow(ctx, `
		insert into event_store (
			event_id,
			event_type,
			event_version,
			aggregate_type,
			aggregate_id,
			aggregate_version,
			payload,
			metadata,
			idempotency_key,
			occurred_at
		)
		values ($1, $2, 1, $3, $4, $5, $6::jsonb, $7::jsonb, $8, now())
		on conflict (idempotency_key)
		  where idempotency_key is not null
		  do nothing
		returning event_type, payload
	`, pgtype.UUID{Bytes: eventID, Valid: true}, eventType, aggregateType, aggregateID, aggregateVersion, payloadJSON, metadataJSON, nullableText(idempotencyKey))

	var inserted eventRecord
	if err := row.Scan(&inserted.EventType, &inserted.Payload); err == nil {
		return inserted, nil
	} else if err != pgx.ErrNoRows {
		return eventRecord{}, err
	}

	row = a.pool.QueryRow(ctx, `
		select event_type, payload
		from event_store
		where idempotency_key = $1
		limit 1
	`, nullableText(idempotencyKey))

	var existing eventRecord
	if err := row.Scan(&existing.EventType, &existing.Payload); err != nil {
		return eventRecord{}, err
	}

	return existing, nil
}

func nextAggregateVersion(ctx context.Context, pool *pgxpool.Pool, aggregateType, aggregateID string) (int64, error) {
	row := pool.QueryRow(ctx, `
		select coalesce(max(aggregate_version), 0)
		from event_store
		where aggregate_type = $1
		  and aggregate_id = $2
	`, aggregateType, aggregateID)

	var version int64
	if err := row.Scan(&version); err != nil {
		return 0, err
	}

	return version + 1, nil
}

func totalAmount(items []contracts.CheckoutItem) int {
	total := 0
	for _, item := range items {
		total += item.UnitPriceAmountMinor * item.Quantity
	}
	return total
}

func nullableText(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}
