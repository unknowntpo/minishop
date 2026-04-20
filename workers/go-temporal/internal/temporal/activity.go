package temporal

import (
	"context"
	"encoding/json"
	"fmt"
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

type CompleteCheckoutInput struct {
	CommandID        string
	CorrelationID    string
	CheckoutIntentID string
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

type orderConfirmedPayload struct {
	OrderID          string                   `json:"order_id"`
	CheckoutIntentID string                   `json:"checkout_intent_id"`
	BuyerID          string                   `json:"buyer_id"`
	Items            []contracts.CheckoutItem `json:"items"`
	TotalAmountMinor int                      `json:"total_amount_minor"`
}

type eventRecord struct {
	ID               int64
	EventID          pgtype.UUID
	EventType        string
	AggregateType    string
	AggregateID      string
	AggregateVersion int64
	Payload          []byte
}

func NewCheckoutCompletionActivities(pool *pgxpool.Pool, logger *zap.Logger) *CheckoutCompletionActivities {
	return &CheckoutCompletionActivities{
		pool:   pool,
		logger: logger,
	}
}

func (a *CheckoutCompletionActivities) CompleteCheckout(ctx context.Context, input CompleteCheckoutInput) error {
	checkout, err := a.loadCheckoutIntent(ctx, input.CheckoutIntentID)
	if err != nil {
		return err
	}

	outcomes := make([]eventRecord, 0, len(checkout.Items))

	for index, item := range checkout.Items {
		onHand, err := a.loadSkuOnHand(ctx, item.SKUID)
		if err != nil {
			return err
		}

		outcome, err := a.reserveInventory(ctx, checkout.CheckoutIntentID, item, onHand, index)
		if err != nil {
			return err
		}
		outcomes = append(outcomes, outcome)
	}

	if rejected := firstRejectedOutcome(outcomes); rejected != nil {
		for _, outcome := range outcomes {
			if outcome.EventType != "InventoryReserved" {
				continue
			}

			var reserved inventoryReservedPayload
			if err := json.Unmarshal(outcome.Payload, &reserved); err != nil {
				return err
			}

			if _, err := a.appendEvent(
				ctx,
				"sku",
				reserved.SKUID,
				map[string]any{
					"type":    "InventoryReservationReleased",
					"version": 1,
					"payload": inventoryReservationReleasedPayload{
						CheckoutIntentID: reserved.CheckoutIntentID,
						ReservationID:    reserved.ReservationID,
						SKUID:            reserved.SKUID,
						Quantity:         reserved.Quantity,
						Reason:           "cart_reservation_failed",
					},
				},
				fmt.Sprintf("demo-release:%s:%s", reserved.CheckoutIntentID, reserved.ReservationID),
				nextAggregateVersion(ctx, a.pool, "sku", reserved.SKUID),
			); err != nil {
				return err
			}
		}

		a.logger.Info(
			"checkout_completion_rejected",
			zap.String("command_id", input.CommandID),
			zap.String("checkout_intent_id", input.CheckoutIntentID),
			zap.String("reason", rejected.Reason),
		)
		return nil
	}

	paymentID := uuid.NewString()
	orderID := uuid.NewString()
	totalAmountMinor := totalAmount(checkout.Items)

	if _, err := a.appendEvent(
		ctx,
		"payment",
		paymentID,
		map[string]any{
			"type":    "PaymentRequested",
			"version": 1,
			"payload": paymentRequestedPayload{
				PaymentID:        paymentID,
				CheckoutIntentID: checkout.CheckoutIntentID,
				Amount:           totalAmountMinor,
				IdempotencyKey:   fmt.Sprintf("demo-payment:%s", checkout.CheckoutIntentID),
			},
		},
		fmt.Sprintf("demo-payment:%s", checkout.CheckoutIntentID),
		1,
	); err != nil {
		return err
	}

	if _, err := a.appendEvent(
		ctx,
		"order",
		orderID,
		map[string]any{
			"type":    "OrderConfirmed",
			"version": 1,
			"payload": orderConfirmedPayload{
				OrderID:          orderID,
				CheckoutIntentID: checkout.CheckoutIntentID,
				BuyerID:          checkout.BuyerID,
				Items:            checkout.Items,
				TotalAmountMinor: totalAmountMinor,
			},
		},
		fmt.Sprintf("demo-order:%s", checkout.CheckoutIntentID),
		1,
	); err != nil {
		return err
	}

	a.logger.Info(
		"checkout_completion_confirmed",
		zap.String("command_id", input.CommandID),
		zap.String("checkout_intent_id", input.CheckoutIntentID),
		zap.String("payment_id", paymentID),
		zap.String("order_id", orderID),
	)

	return nil
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

func (a *CheckoutCompletionActivities) reserveInventory(
	ctx context.Context,
	checkoutIntentID string,
	item contracts.CheckoutItem,
	onHand int,
	index int,
) (eventRecord, error) {
	priorEvents, err := a.loadAggregateEvents(ctx, "sku", item.SKUID)
	if err != nil {
		return eventRecord{}, err
	}

	available := onHand
	reservations := map[string]reservationState{}

	for _, event := range priorEvents {
		switch event.EventType {
		case "InventoryReserved":
			var payload inventoryReservedPayload
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				return eventRecord{}, err
			}
			available -= payload.Quantity
			reservations[payload.ReservationID] = reservationState{
				CheckoutIntentID: payload.CheckoutIntentID,
				Quantity:         payload.Quantity,
				Status:           "reserved",
			}
		case "InventoryReservationReleased":
			var payload inventoryReservationReleasedPayload
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				return eventRecord{}, err
			}
			if reservation, ok := reservations[payload.ReservationID]; ok && reservation.Status == "reserved" {
				available += payload.Quantity
				reservation.Status = "released"
				reservations[payload.ReservationID] = reservation
			}
		}
	}

	reservationID := uuid.NewString()
	idempotencyKey := fmt.Sprintf("demo-reserve:%s:%d", checkoutIntentID, index)

	if available < item.Quantity {
		return a.appendEvent(
			ctx,
			"sku",
			item.SKUID,
			map[string]any{
				"type":    "InventoryReservationRejected",
				"version": 1,
				"payload": inventoryReservationRejectedPayload{
					CheckoutIntentID: checkoutIntentID,
					ReservationID:    reservationID,
					SKUID:            item.SKUID,
					Quantity:         item.Quantity,
					Reason:           "insufficient_inventory",
				},
			},
			idempotencyKey,
			int64(len(priorEvents)+1),
		)
	}

	return a.appendEvent(
		ctx,
		"sku",
		item.SKUID,
		map[string]any{
			"type":    "InventoryReserved",
			"version": 1,
			"payload": inventoryReservedPayload{
				CheckoutIntentID: checkoutIntentID,
				ReservationID:    reservationID,
				SKUID:            item.SKUID,
				Quantity:         item.Quantity,
				ExpiresAt:        time.Now().UTC().Add(15 * time.Minute).Format(time.RFC3339),
			},
		},
		idempotencyKey,
		int64(len(priorEvents)+1),
	)
}

func (a *CheckoutCompletionActivities) loadAggregateEvents(ctx context.Context, aggregateType, aggregateID string) ([]eventRecord, error) {
	rows, err := a.pool.Query(ctx, `
		select id, event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload
		from event_store
		where aggregate_type = $1
		  and aggregate_id = $2
		order by aggregate_version asc
	`, aggregateType, aggregateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []eventRecord
	for rows.Next() {
		var event eventRecord
		if err := rows.Scan(
			&event.ID,
			&event.EventID,
			&event.EventType,
			&event.AggregateType,
			&event.AggregateID,
			&event.AggregateVersion,
			&event.Payload,
		); err != nil {
			return nil, err
		}
		result = append(result, event)
	}

	return result, rows.Err()
}

func (a *CheckoutCompletionActivities) appendEvent(
	ctx context.Context,
	aggregateType string,
	aggregateID string,
	event map[string]any,
	idempotencyKey string,
	aggregateVersion int64,
) (eventRecord, error) {
	payload, err := json.Marshal(event["payload"])
	if err != nil {
		return eventRecord{}, err
	}

	eventType := event["type"].(string)
	eventVersion := int32(event["version"].(int))
	eventID := uuid.New()
	metadata, err := json.Marshal(contracts.EventMetadata{
		RequestID: uuid.NewString(),
		TraceID:   uuid.NewString(),
		Source:    "worker",
		ActorID:   "go-temporal-checkout",
	})
	if err != nil {
		return eventRecord{}, err
	}

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
		values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,now())
		on conflict (idempotency_key)
		  where idempotency_key is not null
		  do nothing
		returning id, event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload
	`, pgtype.UUID{Bytes: eventID, Valid: true}, eventType, eventVersion, aggregateType, aggregateID, aggregateVersion, payload, metadata, nullableText(idempotencyKey))

	var inserted eventRecord
	if err := row.Scan(
		&inserted.ID,
		&inserted.EventID,
		&inserted.EventType,
		&inserted.AggregateType,
		&inserted.AggregateID,
		&inserted.AggregateVersion,
		&inserted.Payload,
	); err == nil {
		return inserted, nil
	} else if err != pgx.ErrNoRows {
		return eventRecord{}, err
	}

	row = a.pool.QueryRow(ctx, `
		select id, event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload
		from event_store
		where idempotency_key = $1
		limit 1
	`, nullableText(idempotencyKey))

	var existing eventRecord
	if err := row.Scan(
		&existing.ID,
		&existing.EventID,
		&existing.EventType,
		&existing.AggregateType,
		&existing.AggregateID,
		&existing.AggregateVersion,
		&existing.Payload,
	); err != nil {
		return eventRecord{}, err
	}

	return existing, nil
}

func nextAggregateVersion(ctx context.Context, pool *pgxpool.Pool, aggregateType, aggregateID string) int64 {
	row := pool.QueryRow(ctx, `
		select coalesce(max(aggregate_version), 0)
		from event_store
		where aggregate_type = $1
		  and aggregate_id = $2
	`, aggregateType, aggregateID)

	var version int64
	if err := row.Scan(&version); err != nil {
		return 1
	}

	return version + 1
}

type reservationState struct {
	CheckoutIntentID string
	Quantity         int
	Status           string
}

type rejectedOutcome struct {
	Reason string
}

func firstRejectedOutcome(outcomes []eventRecord) *rejectedOutcome {
	for _, outcome := range outcomes {
		if outcome.EventType != "InventoryReservationRejected" {
			continue
		}

		var payload inventoryReservationRejectedPayload
		if err := json.Unmarshal(outcome.Payload, &payload); err != nil {
			return &rejectedOutcome{Reason: "unknown_rejection"}
		}

		return &rejectedOutcome{Reason: payload.Reason}
	}

	return nil
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

	return pgtype.Text{
		String: value,
		Valid:  true,
	}
}
