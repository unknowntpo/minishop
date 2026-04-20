package contracts

const (
	WorkflowName = "buy-intent-command-workflow"
	TaskQueue    = "buy-intent-command-orchestration"

	SignalProcessing       = "buy-intent-processing"
	SignalCreated          = "buy-intent-created"
	SignalFailed           = "buy-intent-failed"
	SignalPaymentSucceeded = "buy-intent-payment-succeeded"
	SignalPaymentFailed    = "buy-intent-payment-failed"
)

const (
	FailureCodeMissingCommandStatus = "missing_command_status"
	FailureCodeMergeFailed          = "merge_failed"
)

type CheckoutItem struct {
	SKUID                string `json:"sku_id"`
	Quantity             int    `json:"quantity"`
	UnitPriceAmountMinor int    `json:"unit_price_amount_minor"`
	Currency             string `json:"currency"`
}

type EventMetadata struct {
	RequestID string `json:"request_id"`
	TraceID   string `json:"trace_id"`
	Source    string `json:"source"`
	ActorID   string `json:"actor_id"`
}

type BuyIntentCommand struct {
	CommandID      string         `json:"command_id"`
	CorrelationID  string         `json:"correlation_id"`
	BuyerID        string         `json:"buyer_id"`
	Items          []CheckoutItem `json:"items"`
	IdempotencyKey string         `json:"idempotency_key,omitempty"`
	Metadata       EventMetadata  `json:"metadata"`
	IssuedAt       string         `json:"issued_at"`
}

type WorkflowInput struct {
	CommandID     string `json:"commandId"`
	CorrelationID string `json:"correlationId"`
	IssuedAt      string `json:"issuedAt"`
}

type CreatedSignalPayload struct {
	CheckoutIntentID string `json:"checkoutIntentId"`
	EventID          string `json:"eventId"`
	IsDuplicate      bool   `json:"isDuplicate"`
}

type FailedSignalPayload struct {
	FailureCode    string `json:"failureCode"`
	FailureMessage string `json:"failureMessage"`
}

type PaymentSucceededSignalPayload struct {
	ProviderReference string `json:"providerReference"`
}

type PaymentFailedSignalPayload struct {
	Reason string `json:"reason"`
}

type WorkflowResult struct {
	CommandID        string `json:"commandId"`
	Status           string `json:"status"`
	CheckoutIntentID string `json:"checkoutIntentId,omitempty"`
	EventID          string `json:"eventId,omitempty"`
	IsDuplicate      bool   `json:"isDuplicate,omitempty"`
	CheckoutStatus   string `json:"checkoutStatus,omitempty"`
	OrderID          string `json:"orderId,omitempty"`
	PaymentID        string `json:"paymentId,omitempty"`
	FailureCode      string `json:"failureCode,omitempty"`
	FailureMessage   string `json:"failureMessage,omitempty"`
}

type CheckoutIntentCreatedPayload struct {
	CheckoutIntentID string         `json:"checkout_intent_id"`
	BuyerID          string         `json:"buyer_id"`
	Items            []CheckoutItem `json:"items"`
	IdempotencyKey   string         `json:"idempotency_key,omitempty"`
}

func WorkflowID(commandID string) string {
	return "buy-intent-command/" + commandID
}
