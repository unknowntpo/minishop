package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	hertzapp "github.com/cloudwego/hertz/pkg/app"
	hserver "github.com/cloudwego/hertz/pkg/app/server"
	"github.com/cloudwego/hertz/pkg/common/hlog"
	"github.com/cloudwego/hertz/pkg/protocol/consts"
	gojson "github.com/goccy/go-json"
	"github.com/google/uuid"
	pyroscope "github.com/grafana/pyroscope-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

type config struct {
	addr                 string
	httpEngine           string
	corsAllowedOrigins   []string
	databaseURL          string
	databasePoolMax      int
	natsURL              string
	natsStreamName       string
	natsSubject          string
	natsRetrySubject     string
	natsDLQSubject       string
	kafkaBrokers         []string
	kafkaClientID        string
	kafkaRequestTopic    string
	kafkaResultTopic     string
	kafkaDLQTopic        string
	kafkaTopicPartitions int
	kafkaBucketCount     int
	kafkaMaxProbe        int
	kafkaBatchSize       int
	kafkaLingerMs        int
	kafkaCompression     string
	seckillConfigTTL     time.Duration
	forcedSeckillSKUs    map[string]int
	benchmarkResultsRoot string
	serviceName          string
	otlpEndpoint         string
	otelEnabled          bool
	pprofEnabled         bool
	pprofAddr            string
	pyroscopeEnabled     bool
	pyroscopeServerURL   string
	pyroscopeAppName     string
}

type app struct {
	cfg      config
	db       *pgxpool.Pool
	kafka    *kgo.Client
	natsConn *nats.Conn
	natsJS   nats.JetStreamContext
	cache    *skuConfigCache
	tracer   trace.Tracer
}

type skuConfigCache struct {
	mu      sync.RWMutex
	entries map[string]cachedSeckillConfig
}

type cachedSeckillConfig struct {
	enabled     bool
	stockLimit  int
	expiresAtMs int64
}

type requestContext struct {
	requestID string
	traceID   string
}

type requestBody struct {
	BuyerID        string        `json:"buyerId"`
	Items          []requestItem `json:"items"`
	IdempotencyKey string        `json:"idempotencyKey,omitempty"`
}

type requestItem struct {
	SkuID                string `json:"skuId"`
	Quantity             int    `json:"quantity"`
	UnitPriceAmountMinor int    `json:"unitPriceAmountMinor"`
	Currency             string `json:"currency"`
}

type checkoutItem struct {
	SkuID                string `json:"sku_id"`
	Quantity             int    `json:"quantity"`
	UnitPriceAmountMinor int    `json:"unit_price_amount_minor"`
	Currency             string `json:"currency"`
}

type buyIntentCommand struct {
	CommandID      string         `json:"command_id"`
	CorrelationID  string         `json:"correlation_id"`
	BuyerID        string         `json:"buyer_id"`
	Items          []checkoutItem `json:"items"`
	IdempotencyKey string         `json:"idempotency_key,omitempty"`
	Metadata       eventMetadata  `json:"metadata"`
	IssuedAt       string         `json:"issued_at"`
}

type eventMetadata struct {
	RequestID     string `json:"request_id"`
	TraceID       string `json:"trace_id"`
	Source        string `json:"source"`
	ActorID       string `json:"actor_id"`
	CommandID     string `json:"command_id,omitempty"`
	CorrelationID string `json:"correlation_id,omitempty"`
	Traceparent   string `json:"traceparent,omitempty"`
	Tracestate    string `json:"tracestate,omitempty"`
	Baggage       string `json:"baggage,omitempty"`
}

type seckillEventMetadata struct {
	RequestID string `json:"request_id"`
	TraceID   string `json:"trace_id"`
	Source    string `json:"source"`
	ActorID   string `json:"actor_id"`
}

type seckillBuyIntentCommand struct {
	CommandID      string               `json:"command_id"`
	CorrelationID  string               `json:"correlation_id"`
	BuyerID        string               `json:"buyer_id"`
	Items          []checkoutItem       `json:"items"`
	IdempotencyKey string               `json:"idempotency_key,omitempty"`
	Metadata       seckillEventMetadata `json:"metadata"`
	IssuedAt       string               `json:"issued_at"`
}

type seckillBuyIntentRequest struct {
	SkuID             string                  `json:"sku_id"`
	Quantity          int                     `json:"quantity"`
	SeckillStockLimit int                     `json:"seckill_stock_limit"`
	BucketCount       int                     `json:"bucket_count"`
	PrimaryBucketID   int                     `json:"primary_bucket_id"`
	BucketID          int                     `json:"bucket_id"`
	Attempt           int                     `json:"attempt"`
	MaxProbe          int                     `json:"max_probe"`
	ProcessingKey     string                  `json:"processing_key"`
	Command           seckillBuyIntentCommand `json:"command"`
}

type acceptResponse struct {
	CommandID     string `json:"commandId"`
	CorrelationID string `json:"correlationId"`
	Status        string `json:"status"`
}

type createCheckoutIntentResponse struct {
	CheckoutIntentID string `json:"checkoutIntentId"`
	EventID          string `json:"eventId"`
	Status           string `json:"status"`
	IdempotentReplay bool   `json:"idempotentReplay"`
}

type errorResponse struct {
	Error     string `json:"error"`
	RequestID string `json:"requestId"`
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

type checkoutIntentResponse struct {
	CheckoutIntentID   string         `json:"checkoutIntentId"`
	BuyerID            string         `json:"buyerId"`
	Status             string         `json:"status"`
	Items              []checkoutItem `json:"items"`
	PaymentID          *string        `json:"paymentId"`
	OrderID            *string        `json:"orderId"`
	RejectionReason    *string        `json:"rejectionReason"`
	CancellationReason *string        `json:"cancellationReason"`
	AggregateVersion   int64          `json:"aggregateVersion"`
	LastEventID        int64          `json:"lastEventId"`
	UpdatedAt          string         `json:"updatedAt"`
}

type productInventoryResponse struct {
	OnHand           int     `json:"onHand"`
	Reserved         int     `json:"reserved"`
	Sold             int     `json:"sold"`
	Available        int     `json:"available"`
	AggregateVersion int64   `json:"aggregateVersion"`
	LastEventID      int64   `json:"lastEventId"`
	UpdatedAt        *string `json:"updatedAt"`
	ProjectionLagMs  *int64  `json:"projectionLagMs"`
}

type productSeckillResponse struct {
	Candidate    bool `json:"candidate"`
	Enabled      bool `json:"enabled"`
	StockLimit   *int `json:"stockLimit"`
	DefaultStock *int `json:"defaultStock"`
}

type productImageResponse struct {
	Src string `json:"src"`
	Alt string `json:"alt"`
}

type productResponse struct {
	Slug             string                   `json:"slug"`
	Name             string                   `json:"name"`
	SkuID            string                   `json:"skuId"`
	SkuCode          string                   `json:"skuCode"`
	Summary          string                   `json:"summary"`
	CheckoutNote     string                   `json:"checkoutNote"`
	PriceAmountMinor int                      `json:"priceAmountMinor"`
	Currency         string                   `json:"currency"`
	Available        int                      `json:"available"`
	Inventory        productInventoryResponse `json:"inventory"`
	Seckill          productSeckillResponse   `json:"seckill"`
	Image            productImageResponse     `json:"image"`
}

type adminProductResponse struct {
	ProductID                 string  `json:"productId"`
	ProductName               string  `json:"productName"`
	ProductStatus             string  `json:"productStatus"`
	SkuID                     string  `json:"skuId"`
	SkuCode                   string  `json:"skuCode"`
	SkuName                   string  `json:"skuName"`
	SkuStatus                 string  `json:"skuStatus"`
	PriceAmountMinor          int     `json:"priceAmountMinor"`
	Currency                  string  `json:"currency"`
	OnHand                    *int    `json:"onHand"`
	Reserved                  *int    `json:"reserved"`
	Sold                      *int    `json:"sold"`
	Available                 *int    `json:"available"`
	InventoryLastEventID      *int64  `json:"inventoryLastEventId"`
	InventoryAggregateVersion *int64  `json:"inventoryAggregateVersion"`
	SeckillCandidate          bool    `json:"seckillCandidate"`
	SeckillEnabled            bool    `json:"seckillEnabled"`
	SeckillStockLimit         *int    `json:"seckillStockLimit"`
	SeckillDefaultStock       *int    `json:"seckillDefaultStock"`
	SeckillReservedCount      int     `json:"seckillReservedCount"`
	SeckillRejectedCount      int     `json:"seckillRejectedCount"`
	SeckillLastProcessedAt    *string `json:"seckillLastProcessedAt"`
}

type adminCheckoutResponse struct {
	CheckoutIntentID   string  `json:"checkoutIntentId"`
	BuyerID            string  `json:"buyerId"`
	Status             string  `json:"status"`
	PaymentID          *string `json:"paymentId"`
	OrderID            *string `json:"orderId"`
	RejectionReason    *string `json:"rejectionReason"`
	CancellationReason *string `json:"cancellationReason"`
	AggregateVersion   int64   `json:"aggregateVersion"`
	LastEventID        int64   `json:"lastEventId"`
	UpdatedAt          string  `json:"updatedAt"`
}

type adminCheckoutStatusCountResponse struct {
	Status string `json:"status"`
	Count  int    `json:"count"`
}

type adminCheckoutSummaryResponse struct {
	DisplayedLimit int                                `json:"displayedLimit"`
	TotalCount     int                                `json:"totalCount"`
	StatusCounts   []adminCheckoutStatusCountResponse `json:"statusCounts"`
}

type adminCheckpointResponse struct {
	ProjectionName string `json:"projectionName"`
	LastEventID    int64  `json:"lastEventId"`
	UpdatedAt      string `json:"updatedAt"`
}

type adminDashboardResponse struct {
	Products        []adminProductResponse       `json:"products"`
	CheckoutSummary adminCheckoutSummaryResponse `json:"checkoutSummary"`
	Checkouts       []adminCheckoutResponse      `json:"checkouts"`
	Checkpoints     []adminCheckpointResponse    `json:"checkpoints"`
	RefreshedAt     string                       `json:"refreshedAt"`
}

type checkoutCompleteResponse struct {
	CheckoutIntentID   string  `json:"checkoutIntentId"`
	CommandID          *string `json:"commandId"`
	CommandStatus      *string `json:"commandStatus"`
	Status             string  `json:"status"`
	OrderID            *string `json:"orderId"`
	PaymentID          *string `json:"paymentId"`
	RejectionReason    *string `json:"rejectionReason"`
	CancellationReason *string `json:"cancellationReason"`
	UpdatedAt          string  `json:"updatedAt"`
}

type projectionProcessResult struct {
	Locked          bool  `json:"locked"`
	ProcessedEvents int   `json:"processedEvents"`
	LastEventID     int64 `json:"lastEventId"`
}

type completeDemoCheckoutResponse struct {
	CheckoutIntentID string  `json:"checkoutIntentId"`
	Status           string  `json:"status"`
	OrderID          *string `json:"orderId,omitempty"`
	PaymentID        *string `json:"paymentId,omitempty"`
	Reason           *string `json:"reason,omitempty"`
}

type seckillRoutingDecision struct {
	kind       string
	skuID      string
	stockLimit int
}

type eventStoreAppendInput struct {
	eventID          string
	eventType        string
	eventVersion     int
	aggregateType    string
	aggregateID      string
	aggregateVersion int64
	payload          any
	metadata         eventMetadata
	idempotencyKey   *string
	occurredAt       time.Time
}

type storedEvent struct {
	ID               int64
	EventID          string
	EventType        string
	EventVersion     int
	AggregateType    string
	AggregateID      string
	AggregateVersion int64
	PayloadJSON      []byte
	MetadataJSON     []byte
	IdempotencyKey   *string
	OccurredAt       time.Time
	WasReplay        bool
}

type domainCheckoutIntentCreated struct {
	Type    string                             `json:"type"`
	Version int                                `json:"version"`
	Payload domainCheckoutIntentCreatedPayload `json:"payload"`
}

type domainCheckoutIntentCreatedPayload struct {
	CheckoutIntentID string         `json:"checkout_intent_id"`
	BuyerID          string         `json:"buyer_id"`
	Items            []checkoutItem `json:"items"`
	IdempotencyKey   string         `json:"idempotency_key,omitempty"`
}

type inventoryReservationRequestedEvent struct {
	Type    string                               `json:"type"`
	Version int                                  `json:"version"`
	Payload inventoryReservationRequestedPayload `json:"payload"`
}

type inventoryReservationRequestedPayload struct {
	CheckoutIntentID string `json:"checkout_intent_id"`
	ReservationID    string `json:"reservation_id"`
	SkuID            string `json:"sku_id"`
	Quantity         int    `json:"quantity"`
}

type inventoryReservedEvent struct {
	Type    string                   `json:"type"`
	Version int                      `json:"version"`
	Payload inventoryReservedPayload `json:"payload"`
}

type inventoryReservedPayload struct {
	CheckoutIntentID string `json:"checkout_intent_id"`
	ReservationID    string `json:"reservation_id"`
	SkuID            string `json:"sku_id"`
	Quantity         int    `json:"quantity"`
	ExpiresAt        string `json:"expires_at"`
}

type inventoryRejectedEvent struct {
	Type    string                   `json:"type"`
	Version int                      `json:"version"`
	Payload inventoryRejectedPayload `json:"payload"`
}

type inventoryRejectedPayload struct {
	CheckoutIntentID string `json:"checkout_intent_id"`
	ReservationID    string `json:"reservation_id"`
	SkuID            string `json:"sku_id"`
	Quantity         int    `json:"quantity"`
	Reason           string `json:"reason"`
}

type inventoryReleasedEvent struct {
	Type    string                   `json:"type"`
	Version int                      `json:"version"`
	Payload inventoryReleasedPayload `json:"payload"`
}

type inventoryReleasedPayload struct {
	CheckoutIntentID string `json:"checkout_intent_id"`
	ReservationID    string `json:"reservation_id"`
	SkuID            string `json:"sku_id"`
	Quantity         int    `json:"quantity"`
	Reason           string `json:"reason"`
}

type paymentRequestedEvent struct {
	Type    string                  `json:"type"`
	Version int                     `json:"version"`
	Payload paymentRequestedPayload `json:"payload"`
}

type paymentRequestedPayload struct {
	PaymentID        string `json:"payment_id"`
	CheckoutIntentID string `json:"checkout_intent_id"`
	Amount           int    `json:"amount"`
	IdempotencyKey   string `json:"idempotency_key"`
}

type orderConfirmedEvent struct {
	Type    string                `json:"type"`
	Version int                   `json:"version"`
	Payload orderConfirmedPayload `json:"payload"`
}

type orderConfirmedPayload struct {
	OrderID          string         `json:"order_id"`
	CheckoutIntentID string         `json:"checkout_intent_id"`
	BuyerID          string         `json:"buyer_id"`
	Items            []checkoutItem `json:"items"`
	TotalAmountMinor int            `json:"total_amount_minor"`
}

type checkoutProjectionRow struct {
	CheckoutIntentID   string
	BuyerID            string
	Status             string
	ItemsJSON          []byte
	PaymentID          *string
	OrderID            *string
	RejectionReason    *string
	CancellationReason *string
	AggregateVersion   int64
	LastEventID        int64
	UpdatedAt          time.Time
}

type catalogProductRow struct {
	ProductID                 string
	ProductName               string
	Description               *string
	SkuID                     string
	SkuCode                   string
	PriceAmountMinor          int
	Currency                  string
	SeckillCandidate          bool
	SeckillEnabled            bool
	SeckillStockLimit         *int
	SeckillDefaultStock       *int
	OnHand                    *int
	Reserved                  *int
	Sold                      *int
	Available                 *int
	InventoryAggregateVersion *int64
	InventoryLastEventID      *int64
	InventoryUpdatedAt        *time.Time
	AttributesJSON            []byte
}

type adminProductRow struct {
	ProductID                 string
	ProductName               string
	ProductStatus             string
	SkuID                     string
	SkuCode                   string
	SkuName                   string
	SkuStatus                 string
	PriceAmountMinor          int
	Currency                  string
	SeckillCandidate          bool
	SeckillEnabled            bool
	SeckillStockLimit         *int
	SeckillDefaultStock       *int
	OnHand                    *int
	Reserved                  *int
	Sold                      *int
	Available                 *int
	InventoryLastEventID      *int64
	InventoryAggregateVersion *int64
	SeckillReservedCount      int
	SeckillRejectedCount      int
	SeckillLastProcessedAt    *time.Time
}

type adminCheckoutRow struct {
	CheckoutIntentID   string
	BuyerID            string
	Status             string
	PaymentID          *string
	OrderID            *string
	RejectionReason    *string
	CancellationReason *string
	AggregateVersion   int64
	LastEventID        int64
	UpdatedAt          time.Time
}

type adminCheckpointRow struct {
	ProjectionName string
	LastEventID    int64
	UpdatedAt      time.Time
}

type checkoutDemoRow struct {
	CheckoutIntentID string
	BuyerID          string
	Items            []checkoutItem
}

type skuAggregateState struct {
	skuID            string
	onHand           int
	reserved         int
	sold             int
	available        int
	aggregateVersion int64
	reservations     map[string]reservationState
}

type reservationState struct {
	checkoutIntentID string
	skuID            string
	quantity         int
	status           string
}

var errMixedCartWithSeckill = errors.New("Mixed cart with seckill SKU is not supported. Please checkout seckill items separately.")

const projectionLockKey = 42420001

func main() {
	cfg := readConfig()
	flush, err := setupTelemetry(cfg.serviceName, cfg.otlpEndpoint, cfg.otelEnabled)
	if err != nil {
		log.Fatalf("setup telemetry: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = flush(ctx)
	}()

	dbCfg, err := pgxpool.ParseConfig(cfg.databaseURL)
	if err != nil {
		log.Fatalf("parse DATABASE_URL: %v", err)
	}
	dbCfg.MaxConns = int32(cfg.databasePoolMax)
	dbCfg.MinConns = 1
	dbCfg.MaxConnLifetime = 5 * time.Minute
	db, err := pgxpool.NewWithConfig(context.Background(), dbCfg)
	if err != nil {
		log.Fatalf("create db pool: %v", err)
	}

	kafkaClient, err := kgo.NewClient(
		kgo.SeedBrokers(cfg.kafkaBrokers...),
		kgo.ClientID(cfg.kafkaClientID),
		kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.RecordPartitioner(kgo.ManualPartitioner()),
		kgo.ProducerLinger(time.Duration(cfg.kafkaLingerMs)*time.Millisecond),
		kgo.MaxBufferedRecords(cfg.kafkaBatchSize),
		kgo.ProducerBatchCompression(kafkaCompressionCodec(cfg.kafkaCompression)),
	)
	if err != nil {
		log.Fatalf("create kafka client: %v", err)
	}

	nc, err := nats.Connect(cfg.natsURL)
	if err != nil {
		log.Fatalf("connect nats: %v", err)
	}
	js, err := nc.JetStream()
	if err != nil {
		log.Fatalf("create jetstream: %v", err)
	}

	instance := &app{
		cfg:      cfg,
		db:       db,
		kafka:    kafkaClient,
		natsConn: nc,
		natsJS:   js,
		cache: &skuConfigCache{
			entries: map[string]cachedSeckillConfig{},
		},
		tracer: otel.Tracer("go-backend"),
	}

	if err := instance.warmUp(context.Background()); err != nil {
		log.Fatalf("warm up go-backend: %v", err)
	}

	shutdown, err := instance.startServer()
	if err != nil {
		log.Fatalf("start server: %v", err)
	}
	profiler, err := instance.startPyroscopeProfiler()
	if err != nil {
		log.Fatalf("start pyroscope profiler: %v", err)
	}
	pprofShutdown, err := instance.startPprofServer()
	if err != nil {
		log.Fatalf("start pprof server: %v", err)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = shutdown(ctx)
	_ = pprofShutdown(ctx)
	if profiler != nil {
		_ = profiler.Stop()
	}
	kafkaClient.Close()
	_ = nc.Drain()
	db.Close()
}

func readConfig() config {
	return config{
		addr:                 envDefault("GO_BACKEND_ADDR", ":3000"),
		httpEngine:           strings.ToLower(envDefault("GO_BACKEND_HTTP_ENGINE", "nethttp")),
		corsAllowedOrigins:   splitCSV(envDefault("GO_BACKEND_CORS_ALLOWED_ORIGINS", "*")),
		databaseURL:          requiredEnv("DATABASE_URL"),
		databasePoolMax:      envInt("DATABASE_POOL_MAX", 8),
		natsURL:              envDefault("NATS_URL", "nats://nats:4222"),
		natsStreamName:       envDefault("NATS_BUY_INTENT_STREAM", "BUY_INTENT_COMMANDS"),
		natsSubject:          envDefault("NATS_BUY_INTENT_SUBJECT", "buy-intent.command"),
		natsRetrySubject:     envDefault("NATS_BUY_INTENT_RETRY_SUBJECT", "buy-intent.retry"),
		natsDLQSubject:       envDefault("NATS_BUY_INTENT_DLQ_SUBJECT", "buy-intent.dlq"),
		kafkaBrokers:         splitCSV(envDefault("KAFKA_BROKERS", "redpanda:9092")),
		kafkaClientID:        envDefault("KAFKA_CLIENT_ID", "minishop-go-backend"),
		kafkaRequestTopic:    envDefault("KAFKA_SECKILL_REQUEST_TOPIC", "inventory.seckill.requested"),
		kafkaResultTopic:     envDefault("KAFKA_SECKILL_RESULT_TOPIC", "inventory.seckill.result"),
		kafkaDLQTopic:        envDefault("KAFKA_SECKILL_DLQ_TOPIC", "inventory.seckill.dlq"),
		kafkaTopicPartitions: envInt("KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS", envInt("SECKILL_BUCKET_COUNT", envInt("KAFKA_SECKILL_BUCKET_COUNT", 4))),
		kafkaBucketCount:     envInt("KAFKA_SECKILL_BUCKET_COUNT", envInt("SECKILL_BUCKET_COUNT", 4)),
		kafkaMaxProbe:        envInt("KAFKA_SECKILL_MAX_PROBE", 4),
		kafkaBatchSize:       envInt("KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES", 10000),
		kafkaLingerMs:        envInt("KAFKA_SECKILL_CLIENT_LINGER_MS", 1),
		kafkaCompression:     envDefault("KAFKA_SECKILL_CLIENT_COMPRESSION", "none"),
		seckillConfigTTL:     time.Duration(envInt("KAFKA_SECKILL_CONFIG_CACHE_TTL_MS", 60000)) * time.Millisecond,
		forcedSeckillSKUs:    readForcedSeckillSKUs(),
		benchmarkResultsRoot: envDefault("GO_BACKEND_BENCHMARK_RESULTS_ROOT", defaultBenchmarkResultsRoot()),
		serviceName:          envDefault("OTEL_SERVICE_NAME", "go-backend"),
		otlpEndpoint:         envDefault("OTEL_EXPORTER_OTLP_ENDPOINT", "http://tempo:4318"),
		otelEnabled:          envDefault("OTEL_ENABLED", "1") != "0",
		pprofEnabled:         envDefault("GO_BACKEND_PPROF_ENABLED", "0") == "1",
		pprofAddr:            envDefault("GO_BACKEND_PPROF_ADDR", ":6060"),
		pyroscopeEnabled:     envDefault("PYROSCOPE_ENABLED", "0") == "1",
		pyroscopeServerURL:   envDefault("PYROSCOPE_SERVER_ADDRESS", "http://pyroscope:4040"),
		pyroscopeAppName:     envDefault("PYROSCOPE_APPLICATION_NAME", envDefault("OTEL_SERVICE_NAME", "go-backend")),
	}
}

func defaultBenchmarkResultsRoot() string {
	candidates := []string{
		"/app/benchmark-results",
		filepath.Join(".", "benchmark-results"),
		filepath.Join("..", "benchmark-results"),
		filepath.Join("..", "..", "benchmark-results"),
	}

	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}

	return filepath.Join(".", "benchmark-results")
}

func (a *app) startPprofServer() (func(context.Context) error, error) {
	if !a.cfg.pprofEnabled {
		return func(context.Context) error { return nil }, nil
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.Handle("/debug/pprof/allocs", pprof.Handler("allocs"))
	mux.Handle("/debug/pprof/block", pprof.Handler("block"))
	mux.Handle("/debug/pprof/goroutine", pprof.Handler("goroutine"))
	mux.Handle("/debug/pprof/heap", pprof.Handler("heap"))
	mux.Handle("/debug/pprof/mutex", pprof.Handler("mutex"))
	mux.Handle("/debug/pprof/threadcreate", pprof.Handler("threadcreate"))

	server := &http.Server{
		Addr:              a.cfg.pprofAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Printf("go-backend pprof listening on %s", a.cfg.pprofAddr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("pprof listen: %v", err)
		}
	}()
	return server.Shutdown, nil
}

func (a *app) startPyroscopeProfiler() (*pyroscope.Profiler, error) {
	if !a.cfg.pyroscopeEnabled {
		return nil, nil
	}
	profiler, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: a.cfg.pyroscopeAppName,
		ServerAddress:   a.cfg.pyroscopeServerURL,
		Logger:          pyroscope.StandardLogger,
		Tags: map[string]string{
			"http_engine": a.cfg.httpEngine,
			"service":     a.cfg.serviceName,
		},
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileAllocSpace,
			pyroscope.ProfileInuseObjects,
			pyroscope.ProfileInuseSpace,
			pyroscope.ProfileGoroutines,
			pyroscope.ProfileMutexCount,
			pyroscope.ProfileMutexDuration,
			pyroscope.ProfileBlockCount,
			pyroscope.ProfileBlockDuration,
		},
	})
	if err != nil {
		return nil, err
	}
	log.Printf("go-backend pyroscope enabled server=%s app=%s engine=%s", a.cfg.pyroscopeServerURL, a.cfg.pyroscopeAppName, a.cfg.httpEngine)
	return profiler, nil
}

func (a *app) startServer() (func(context.Context) error, error) {
	switch a.cfg.httpEngine {
	case "nethttp", "":
		return a.startNetHTTPServer()
	case "hertz":
		return a.startHertzServer()
	default:
		return nil, fmt.Errorf("unsupported GO_BACKEND_HTTP_ENGINE %q", a.cfg.httpEngine)
	}
}

func (a *app) startNetHTTPServer() (func(context.Context) error, error) {
	mux := http.NewServeMux()
	mux.Handle("/healthz", otelhttp.NewHandler(http.HandlerFunc(a.handleHealthz), "GET /healthz"))
	mux.Handle("/api/products", otelhttp.NewHandler(http.HandlerFunc(a.handleListProducts), "GET /api/products"))
	mux.Handle("/api/products/", otelhttp.NewHandler(http.HandlerFunc(a.handleGetProductBySlug), "GET /api/products/{slug}"))
	mux.Handle("/api/buy-intents", otelhttp.NewHandler(http.HandlerFunc(a.handleBuyIntents), "POST /api/buy-intents"))
	mux.Handle("/api/buy-intent-commands/", otelhttp.NewHandler(http.HandlerFunc(a.handleGetBuyIntentCommand), "GET /api/buy-intent-commands/{commandId}"))
	mux.Handle("/api/checkout-intents", otelhttp.NewHandler(http.HandlerFunc(a.handleCreateCheckoutIntent), "POST /api/checkout-intents"))
	mux.Handle("/api/checkout-intents/", otelhttp.NewHandler(http.HandlerFunc(a.handleGetCheckoutIntent), "GET /api/checkout-intents/{checkoutIntentId}"))
	mux.Handle("/api/checkout-complete/", otelhttp.NewHandler(http.HandlerFunc(a.handleGetCheckoutComplete), "GET /api/checkout-complete/{checkoutIntentId}"))
	mux.Handle("/api/internal/admin/dashboard", otelhttp.NewHandler(http.HandlerFunc(a.handleGetAdminDashboard), "GET /api/internal/admin/dashboard"))
	mux.Handle("/api/internal/admin/seckill", otelhttp.NewHandler(http.HandlerFunc(a.handleUpdateAdminSeckill), "POST /api/internal/admin/seckill"))
	mux.Handle("/api/internal/benchmarks", otelhttp.NewHandler(http.HandlerFunc(a.handleListBenchmarks), "GET /api/internal/benchmarks"))
	mux.Handle("/api/internal/projections/process", otelhttp.NewHandler(http.HandlerFunc(a.handleProcessProjections), "POST /api/internal/projections/process"))
	mux.Handle("/api/internal/checkout-intents/", otelhttp.NewHandler(http.HandlerFunc(a.handleCompleteDemoCheckout), "POST /api/internal/checkout-intents/{checkoutIntentId}/complete-demo"))

	server := &http.Server{
		Addr:              a.cfg.addr,
		Handler:           withCORS(a.cfg, mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("go-backend listening on %s engine=%s", a.cfg.addr, a.cfg.httpEngine)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	return server.Shutdown, nil
}

func (a *app) startHertzServer() (func(context.Context) error, error) {
	hlog.SetLevel(hlog.LevelWarn)
	server := hserver.Default(
		hserver.WithHostPorts(a.cfg.addr),
		hserver.WithDisablePrintRoute(true),
		hserver.WithReadTimeout(5*time.Second),
	)
	server.Use(a.hertzCORS())
	server.GET("/healthz", a.handleHealthzHertz)
	server.POST("/api/buy-intents", a.handleBuyIntentsHertz)
	server.GET("/api/internal/benchmarks", a.handleListBenchmarksHertz)

	go func() {
		log.Printf("go-backend listening on %s engine=%s", a.cfg.addr, a.cfg.httpEngine)
		if err := server.Run(); err != nil {
			log.Fatalf("listen: %v", err)
		}
	}()

	return func(context.Context) error {
		return server.Shutdown(context.Background())
	}, nil
}

func (a *app) warmUp(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := a.db.Ping(ctx); err != nil {
		return fmt.Errorf("db ping: %w", err)
	}
	if err := ensureKafkaTopics(ctx, a.kafka, []string{
		a.cfg.kafkaRequestTopic,
		a.cfg.kafkaResultTopic,
		a.cfg.kafkaDLQTopic,
	}, a.cfg.kafkaTopicPartitions); err != nil {
		return fmt.Errorf("ensure kafka topics: %w", err)
	}
	if err := a.kafka.Ping(ctx); err != nil {
		return fmt.Errorf("kafka ping: %w", err)
	}
	if err := a.natsConn.FlushWithContext(ctx); err != nil {
		return fmt.Errorf("nats ping: %w", err)
	}
	if err := ensureBuyIntentCommandStream(ctx, a.natsJS, a.cfg); err != nil {
		return fmt.Errorf("ensure nats stream: %w", err)
	}
	return nil
}

func (a *app) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (a *app) handleHealthzHertz(_ context.Context, c *hertzapp.RequestContext) {
	c.SetStatusCode(consts.StatusOK)
	c.SetContentTypeBytes([]byte("text/plain; charset=utf-8"))
	c.WriteString("ok")
}

func (a *app) handleListProducts(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "catalog.list")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	products, err := a.readProducts(ctx)
	if err != nil {
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Catalog is temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, reqCtx, products)
}

func (a *app) handleGetProductBySlug(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "catalog.read")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	slug := strings.TrimPrefix(r.URL.Path, "/api/products/")
	if strings.TrimSpace(slug) == "" {
		writeError(w, reqCtx, http.StatusNotFound, "Product not found.")
		return
	}
	product, err := a.readProductBySlug(ctx, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, reqCtx, http.StatusNotFound, "Product not found.")
			return
		}
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Catalog is temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, reqCtx, product)
}

func (a *app) handleBuyIntents(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "buy_intent.accept")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	body, err := decodeRequestBody[requestBody](r)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid_json")
		log.Printf("go-backend decode_request_failed request_id=%s err=%v", reqCtx.requestID, err)
		writeError(w, reqCtx, http.StatusBadRequest, "Request body must be valid JSON.")
		return
	}
	if err := validateCreateCheckoutIntentRequest(body); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid_request")
		log.Printf("go-backend validate_request_failed request_id=%s err=%v body=%+v", reqCtx.requestID, err, body)
		writeError(w, reqCtx, http.StatusBadRequest, err.Error())
		return
	}

	decision, err := a.classifyItemsForSeckill(ctx, body.Items)
	if err != nil {
		if errors.Is(err, errMixedCartWithSeckill) {
			writeError(w, reqCtx, http.StatusBadRequest, err.Error())
			return
		}
		span.RecordError(err)
		span.SetStatus(codes.Error, "routing_failed")
		log.Printf("go-backend classify_seckill_failed request_id=%s err=%v", reqCtx.requestID, err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Buy intent command could not be accepted. Please try again.")
		return
	}

	commandID := uuid.NewString()
	correlationID := uuid.NewString()
	idempotencyKey := strings.TrimSpace(r.Header.Get("idempotency-key"))
	if idempotencyKey == "" {
		idempotencyKey = strings.TrimSpace(body.IdempotencyKey)
	}
	traceCarrier := injectTraceCarrier(ctx)
	command := buyIntentCommand{
		CommandID:      commandID,
		CorrelationID:  correlationID,
		BuyerID:        body.BuyerID,
		Items:          toCheckoutItems(body.Items),
		IdempotencyKey: idempotencyKey,
		Metadata: eventMetadata{
			RequestID:     reqCtx.requestID,
			TraceID:       reqCtx.traceID,
			Source:        "web",
			ActorID:       body.BuyerID,
			CommandID:     commandID,
			CorrelationID: correlationID,
			Traceparent:   traceCarrier["traceparent"],
			Tracestate:    traceCarrier["tracestate"],
			Baggage:       traceCarrier["baggage"],
		},
		IssuedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}

	if decision.kind == "single_seckill" {
		if err := a.publishSeckillCommand(ctx, body, command, decision.stockLimit, reqCtx); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "publish_failed")
			log.Printf("go-backend publish_seckill_failed request_id=%s command_id=%s err=%v", reqCtx.requestID, commandID, err)
			writeError(w, reqCtx, http.StatusInternalServerError, "Buy intent command could not be accepted. Please try again.")
			return
		}
	} else {
		if err := a.publishBuyIntentCommand(ctx, command); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "publish_failed")
			log.Printf("go-backend publish_regular_failed request_id=%s command_id=%s err=%v", reqCtx.requestID, commandID, err)
			writeError(w, reqCtx, http.StatusInternalServerError, "Buy intent command could not be accepted. Please try again.")
			return
		}
	}

	writeJSON(w, http.StatusAccepted, reqCtx, acceptResponse{
		CommandID:     commandID,
		CorrelationID: correlationID,
		Status:        "accepted",
	})
}

func (a *app) handleBuyIntentsHertz(base context.Context, c *hertzapp.RequestContext) {
	ctx, span := a.tracer.Start(base, "buy_intent.accept")
	defer span.End()

	reqCtx := requestContextFromHertz(ctx, c)
	body, err := decodeHertzBody[requestBody](c)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid_json")
		log.Printf("go-backend decode_request_failed request_id=%s err=%v", reqCtx.requestID, err)
		writeErrorHertz(c, reqCtx, consts.StatusBadRequest, "Request body must be valid JSON.")
		return
	}
	if err := validateCreateCheckoutIntentRequest(body); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid_request")
		log.Printf("go-backend validate_request_failed request_id=%s err=%v body=%+v", reqCtx.requestID, err, body)
		writeErrorHertz(c, reqCtx, consts.StatusBadRequest, err.Error())
		return
	}

	decision, err := a.classifyItemsForSeckill(ctx, body.Items)
	if err != nil {
		if errors.Is(err, errMixedCartWithSeckill) {
			writeErrorHertz(c, reqCtx, consts.StatusBadRequest, err.Error())
			return
		}
		span.RecordError(err)
		span.SetStatus(codes.Error, "routing_failed")
		log.Printf("go-backend classify_seckill_failed request_id=%s err=%v", reqCtx.requestID, err)
		writeErrorHertz(c, reqCtx, consts.StatusInternalServerError, "Buy intent command could not be accepted. Please try again.")
		return
	}

	commandID := uuid.NewString()
	correlationID := uuid.NewString()
	idempotencyKey := strings.TrimSpace(string(c.Request.Header.Peek("idempotency-key")))
	if idempotencyKey == "" {
		idempotencyKey = strings.TrimSpace(body.IdempotencyKey)
	}
	traceCarrier := injectTraceCarrier(ctx)
	command := buyIntentCommand{
		CommandID:      commandID,
		CorrelationID:  correlationID,
		BuyerID:        body.BuyerID,
		Items:          toCheckoutItems(body.Items),
		IdempotencyKey: idempotencyKey,
		Metadata: eventMetadata{
			RequestID:     reqCtx.requestID,
			TraceID:       reqCtx.traceID,
			Source:        "web",
			ActorID:       body.BuyerID,
			CommandID:     commandID,
			CorrelationID: correlationID,
			Traceparent:   traceCarrier["traceparent"],
			Tracestate:    traceCarrier["tracestate"],
			Baggage:       traceCarrier["baggage"],
		},
		IssuedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}

	if decision.kind == "single_seckill" {
		if err := a.publishSeckillCommand(ctx, body, command, decision.stockLimit, reqCtx); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "publish_failed")
			log.Printf("go-backend publish_seckill_failed request_id=%s command_id=%s err=%v", reqCtx.requestID, commandID, err)
			writeErrorHertz(c, reqCtx, consts.StatusInternalServerError, "Buy intent command could not be accepted. Please try again.")
			return
		}
	} else {
		if err := a.publishBuyIntentCommand(ctx, command); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "publish_failed")
			log.Printf("go-backend publish_regular_failed request_id=%s command_id=%s err=%v", reqCtx.requestID, commandID, err)
			writeErrorHertz(c, reqCtx, consts.StatusInternalServerError, "Buy intent command could not be accepted. Please try again.")
			return
		}
	}

	writeJSONHertz(c, consts.StatusAccepted, reqCtx, acceptResponse{
		CommandID:     commandID,
		CorrelationID: correlationID,
		Status:        "accepted",
	})
}

func (a *app) publishBuyIntentCommand(ctx context.Context, command buyIntentCommand) error {
	if err := ensureBuyIntentCommandStream(ctx, a.natsJS, a.cfg); err != nil {
		return err
	}
	payload, err := json.Marshal(command)
	if err != nil {
		return err
	}
	msg := nats.NewMsg(a.cfg.natsSubject)
	msg.Data = payload
	msg.Header.Set(nats.MsgIdHdr, command.CommandID)
	for key, value := range injectTraceCarrier(ctx) {
		if strings.TrimSpace(value) != "" {
			msg.Header.Set(key, value)
		}
	}
	_, err = a.natsJS.PublishMsg(msg)
	return err
}

func (a *app) publishSeckillCommand(
	ctx context.Context,
	body requestBody,
	command buyIntentCommand,
	stockLimit int,
	reqCtx requestContext,
) error {
	item := body.Items[0]
	stableKey := command.IdempotencyKey
	if stableKey == "" {
		stableKey = command.CommandID
	}
	primaryBucketID := selectPrimaryBucket(stableKey, a.cfg.kafkaBucketCount)
	payload, err := json.Marshal(seckillBuyIntentRequest{
		SkuID:             item.SkuID,
		Quantity:          item.Quantity,
		SeckillStockLimit: stockLimit,
		BucketCount:       a.cfg.kafkaBucketCount,
		PrimaryBucketID:   primaryBucketID,
		BucketID:          primaryBucketID,
		Attempt:           0,
		MaxProbe:          a.cfg.kafkaMaxProbe,
		ProcessingKey:     buildProcessingKey(item.SkuID, primaryBucketID),
		Command: seckillBuyIntentCommand{
			CommandID:      command.CommandID,
			CorrelationID:  command.CorrelationID,
			BuyerID:        command.BuyerID,
			Items:          command.Items,
			IdempotencyKey: command.IdempotencyKey,
			Metadata: seckillEventMetadata{
				RequestID: command.Metadata.RequestID,
				TraceID:   command.Metadata.TraceID,
				Source:    command.Metadata.Source,
				ActorID:   command.Metadata.ActorID,
			},
			IssuedAt: command.IssuedAt,
		},
	})
	if err != nil {
		return err
	}
	headers := make([]kgo.RecordHeader, 0, 3)
	for key, value := range injectTraceCarrier(ctx) {
		if strings.TrimSpace(value) != "" {
			headers = append(headers, kgo.RecordHeader{Key: key, Value: []byte(value)})
		}
	}
	processingKey := buildProcessingKey(item.SkuID, primaryBucketID)
	record := &kgo.Record{
		Topic:     a.cfg.kafkaRequestTopic,
		Partition: normalizeSeckillPartition(primaryBucketID),
		Key:       []byte(processingKey),
		Value:     payload,
		Timestamp: time.Now().UTC(),
		Headers:   headers,
	}
	a.kafka.Produce(context.Background(), record, func(produced *kgo.Record, err error) {
		if err == nil {
			return
		}
		topic := record.Topic
		partition := record.Partition
		if produced != nil {
			topic = produced.Topic
			partition = produced.Partition
		}
		log.Printf("go-backend async_seckill_publish_failed request_id=%s command_id=%s topic=%s partition=%d: %v", reqCtx.requestID, command.CommandID, topic, partition, err)
	})
	return nil
}

func (a *app) handleGetBuyIntentCommand(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "buy_intent.read_status")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	commandID := strings.TrimPrefix(r.URL.Path, "/api/buy-intent-commands/")
	if commandID == "" {
		writeError(w, reqCtx, http.StatusNotFound, "Buy intent command not found.")
		return
	}
	row := a.db.QueryRow(ctx, `
      select
        command_id,
        correlation_id,
        status,
        checkout_intent_id,
        event_id,
        is_duplicate,
        failure_code,
        failure_message,
        created_at,
        updated_at
      from command_status
      where command_id = $1
      limit 1
    `, commandID)

	var response commandStatusResponse
	var createdAt time.Time
	var updatedAt time.Time
	if err := row.Scan(
		&response.CommandID,
		&response.CorrelationID,
		&response.Status,
		&response.CheckoutIntentID,
		&response.EventID,
		&response.IsDuplicate,
		&response.FailureCode,
		&response.FailureMessage,
		&createdAt,
		&updatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, reqCtx, http.StatusNotFound, "Buy intent command not found.")
			return
		}
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Buy intent command status is temporarily unavailable.")
		return
	}
	response.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	response.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	writeJSON(w, http.StatusOK, reqCtx, response)
}

func (a *app) handleCreateCheckoutIntent(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "checkout.create")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	body, err := decodeRequestBody[requestBody](r)
	if err != nil {
		writeError(w, reqCtx, http.StatusInternalServerError, "Checkout request could not be accepted. Please try again.")
		return
	}
	if err := validateCreateCheckoutIntentRequest(body); err != nil {
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Checkout request could not be accepted. Please try again.")
		return
	}

	idempotencyKey := strings.TrimSpace(r.Header.Get("idempotency-key"))
	if idempotencyKey == "" {
		idempotencyKey = strings.TrimSpace(body.IdempotencyKey)
	}
	checkoutIntentID := uuid.NewString()
	eventID := uuid.NewString()
	metadata := eventMetadata{
		RequestID:   reqCtx.requestID,
		TraceID:     reqCtx.traceID,
		Source:      "web",
		ActorID:     body.BuyerID,
		Traceparent: injectTraceCarrier(ctx)["traceparent"],
		Tracestate:  injectTraceCarrier(ctx)["tracestate"],
		Baggage:     injectTraceCarrier(ctx)["baggage"],
	}
	event := domainCheckoutIntentCreated{
		Type:    "CheckoutIntentCreated",
		Version: 1,
		Payload: domainCheckoutIntentCreatedPayload{
			CheckoutIntentID: checkoutIntentID,
			BuyerID:          body.BuyerID,
			Items:            toCheckoutItems(body.Items),
			IdempotencyKey:   idempotencyKey,
		},
	}
	var idemKey *string
	if idempotencyKey != "" {
		idemKey = &idempotencyKey
	}
	stored, err := a.appendEvent(ctx, eventStoreAppendInput{
		eventID:          eventID,
		eventType:        event.Type,
		eventVersion:     event.Version,
		aggregateType:    "checkout",
		aggregateID:      checkoutIntentID,
		aggregateVersion: 1,
		payload:          event.Payload,
		metadata:         metadata,
		idempotencyKey:   idemKey,
		occurredAt:       time.Now().UTC(),
	})
	if err != nil {
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Checkout request could not be accepted. Please try again.")
		return
	}
	var payload domainCheckoutIntentCreatedPayload
	if err := json.Unmarshal(stored.PayloadJSON, &payload); err != nil {
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Checkout request could not be accepted. Please try again.")
		return
	}
	writeJSON(w, ternaryStatus(stored.WasReplay, http.StatusOK, http.StatusAccepted), reqCtx, createCheckoutIntentResponse{
		CheckoutIntentID: payload.CheckoutIntentID,
		EventID:          stored.EventID,
		Status:           "queued",
		IdempotentReplay: stored.WasReplay,
	})
}

func (a *app) handleGetCheckoutIntent(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "checkout.read")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	checkoutIntentID := strings.TrimPrefix(r.URL.Path, "/api/checkout-intents/")
	if checkoutIntentID == "" {
		writeError(w, reqCtx, http.StatusNotFound, "Checkout intent projection not found.")
		return
	}
	row, err := a.readCheckoutProjection(ctx, checkoutIntentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, reqCtx, http.StatusNotFound, "Checkout intent projection not found.")
			return
		}
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Checkout status is temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, reqCtx, row)
}

func (a *app) handleGetCheckoutComplete(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "checkout.read_complete")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	checkoutIntentID := strings.TrimPrefix(r.URL.Path, "/api/checkout-complete/")
	if checkoutIntentID == "" {
		writeError(w, reqCtx, http.StatusNotFound, "Checkout completion summary not found.")
		return
	}
	result, err := a.readCheckoutComplete(ctx, checkoutIntentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, reqCtx, http.StatusNotFound, "Checkout completion summary not found.")
			return
		}
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Checkout status is temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, reqCtx, result)
}

func (a *app) handleGetAdminDashboard(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "admin.dashboard")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	dashboard, err := a.readAdminDashboard(ctx)
	if err != nil {
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Admin dashboard is temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, reqCtx, dashboard)
}

func (a *app) handleListBenchmarks(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "admin.benchmarks")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	runs, err := readBenchmarkRuns(a.cfg.benchmarkResultsRoot)
	if err != nil {
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusInternalServerError, "Benchmark results are temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, reqCtx, runs)
}

func (a *app) handleListBenchmarksHertz(base context.Context, c *hertzapp.RequestContext) {
	ctx, span := a.tracer.Start(base, "admin.benchmarks")
	defer span.End()

	reqCtx := requestContextFromHertz(ctx, c)
	runs, err := readBenchmarkRuns(a.cfg.benchmarkResultsRoot)
	if err != nil {
		span.RecordError(err)
		writeErrorHertz(c, reqCtx, consts.StatusInternalServerError, "Benchmark results are temporarily unavailable.")
		return
	}
	writeJSONHertz(c, consts.StatusOK, reqCtx, runs)
}

func (a *app) handleUpdateAdminSeckill(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "admin.update_seckill")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	body, err := decodeLooseBody(r)
	if err != nil {
		writeError(w, reqCtx, http.StatusBadRequest, "Seckill config update failed.")
		return
	}

	skuID := strings.TrimSpace(stringValue(body["skuId"], ""))
	enabled, ok := body["enabled"].(bool)
	if skuID == "" || !ok {
		writeError(w, reqCtx, http.StatusBadRequest, "Seckill config update failed.")
		return
	}

	var stockLimit *int
	if enabled {
		value := intValue(body["stockLimit"], 0)
		if value <= 0 {
			writeError(w, reqCtx, http.StatusBadRequest, "Seckill config update failed.")
			return
		}
		stockLimit = &value
	}

	if err := a.updateSeckillConfig(ctx, skuID, enabled, stockLimit); err != nil {
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusBadRequest, "Seckill config update failed.")
		return
	}

	writeJSON(w, http.StatusOK, reqCtx, map[string]bool{"ok": true})
}

func (a *app) handleProcessProjections(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "projection.process")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	body, _ := decodeLooseBody(r)
	projectionName := stringValue(body["projectionName"], "main")
	batchSize := intValue(body["batchSize"], 100)
	if strings.TrimSpace(projectionName) == "" || batchSize < 1 || batchSize > 1000 {
		writeError(w, reqCtx, http.StatusBadRequest, "Projection processing failed.")
		return
	}
	result, err := a.processProjectionBatch(ctx, projectionName, batchSize)
	if err != nil {
		span.RecordError(err)
		log.Printf("projection_process_failed request_id=%s projection=%s batch_size=%d err=%v", reqCtx.requestID, projectionName, batchSize, err)
		writeError(w, reqCtx, http.StatusBadRequest, "Projection processing failed.")
		return
	}
	status := http.StatusOK
	if !result.Locked {
		status = http.StatusConflict
	}
	writeJSON(w, status, reqCtx, result)
}

func (a *app) handleCompleteDemoCheckout(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "checkout.complete_demo")
	defer span.End()

	reqCtx := requestContextFromRequest(ctx, r)
	prefix := "/api/internal/checkout-intents/"
	if !strings.HasPrefix(r.URL.Path, prefix) || !strings.HasSuffix(r.URL.Path, "/complete-demo") {
		writeError(w, reqCtx, http.StatusNotFound, "Checkout demo completion failed.")
		return
	}
	checkoutIntentID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, prefix), "/complete-demo")
	result, err := a.completeDemoCheckout(ctx, checkoutIntentID, reqCtx)
	if err != nil {
		span.RecordError(err)
		writeError(w, reqCtx, http.StatusBadRequest, "Checkout demo completion failed.")
		return
	}
	writeJSON(w, http.StatusOK, reqCtx, result)
}

func (a *app) classifyItemsForSeckill(ctx context.Context, items []requestItem) (seckillRoutingDecision, error) {
	if len(items) != 1 {
		hasSeckill, err := a.containsSeckillSKU(ctx, items)
		if err != nil {
			return seckillRoutingDecision{}, err
		}
		if hasSeckill {
			return seckillRoutingDecision{}, errMixedCartWithSeckill
		}
		return seckillRoutingDecision{kind: "default"}, nil
	}

	if stockLimit, ok := a.cfg.forcedSeckillSKUs[items[0].SkuID]; ok && stockLimit > 0 {
		return seckillRoutingDecision{
			kind:       "single_seckill",
			skuID:      items[0].SkuID,
			stockLimit: stockLimit,
		}, nil
	}

	cfg, err := a.readSeckillConfig(ctx, items[0].SkuID)
	if err != nil {
		return seckillRoutingDecision{}, err
	}
	if !cfg.enabled || cfg.stockLimit <= 0 {
		return seckillRoutingDecision{kind: "default"}, nil
	}
	return seckillRoutingDecision{
		kind:       "single_seckill",
		skuID:      items[0].SkuID,
		stockLimit: cfg.stockLimit,
	}, nil
}

func readBenchmarkRuns(root string) ([]map[string]any, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return []map[string]any{}, nil
		}
		return nil, err
	}

	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			childEntries, childErr := os.ReadDir(filepath.Join(root, entry.Name()))
			if childErr != nil {
				if os.IsNotExist(childErr) {
					continue
				}
				return nil, childErr
			}
			for _, child := range childEntries {
				if !child.IsDir() && strings.HasSuffix(child.Name(), ".json") {
					files = append(files, filepath.Join(entry.Name(), child.Name()))
				}
			}
			continue
		}
		if strings.HasSuffix(entry.Name(), ".json") {
			files = append(files, entry.Name())
		}
	}

	runs := make([]map[string]any, 0, len(files))
	for _, file := range files {
		raw, readErr := os.ReadFile(filepath.Join(root, file))
		if readErr != nil {
			continue
		}

		run := map[string]any{}
		if unmarshalErr := json.Unmarshal(raw, &run); unmarshalErr != nil {
			continue
		}

		runID, _ := run["runId"].(string)
		if strings.TrimSpace(runID) == "" {
			continue
		}

		run["artifactFile"] = file
		runs = append(runs, run)
	}

	sort.Slice(runs, func(left, right int) bool {
		return benchmarkRunTimestamp(runs[left]).After(benchmarkRunTimestamp(runs[right]))
	})

	return runs, nil
}

func benchmarkRunTimestamp(run map[string]any) time.Time {
	for _, key := range []string{"finishedAt", "startedAt"} {
		value, _ := run[key].(string)
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			return parsed
		}
	}

	return time.Time{}
}

func (a *app) containsSeckillSKU(ctx context.Context, items []requestItem) (bool, error) {
	seen := map[string]struct{}{}
	for _, item := range items {
		if _, ok := seen[item.SkuID]; ok {
			continue
		}
		seen[item.SkuID] = struct{}{}
		cfg, err := a.readSeckillConfig(ctx, item.SkuID)
		if err != nil {
			return false, err
		}
		if cfg.enabled {
			return true, nil
		}
	}
	return false, nil
}

func (a *app) readSeckillConfig(ctx context.Context, skuID string) (cachedSeckillConfig, error) {
	now := time.Now().UnixMilli()
	a.cache.mu.RLock()
	cached, ok := a.cache.entries[skuID]
	a.cache.mu.RUnlock()
	if ok && cached.expiresAtMs > now {
		return cached, nil
	}

	row := a.db.QueryRow(ctx, `
      select seckill_enabled, coalesce(seckill_stock_limit, 0)
      from sku
      where sku_id = $1
      limit 1
    `, skuID)

	var enabled bool
	var stockLimit int
	if err := row.Scan(&enabled, &stockLimit); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			cfg := cachedSeckillConfig{enabled: false, stockLimit: 0, expiresAtMs: now + a.cfg.seckillConfigTTL.Milliseconds()}
			a.cache.mu.Lock()
			a.cache.entries[skuID] = cfg
			a.cache.mu.Unlock()
			return cfg, nil
		}
		return cachedSeckillConfig{}, err
	}

	cfg := cachedSeckillConfig{
		enabled:     enabled,
		stockLimit:  stockLimit,
		expiresAtMs: now + a.cfg.seckillConfigTTL.Milliseconds(),
	}
	a.cache.mu.Lock()
	a.cache.entries[skuID] = cfg
	a.cache.mu.Unlock()
	return cfg, nil
}

func (a *app) appendEvent(ctx context.Context, input eventStoreAppendInput) (storedEvent, error) {
	payloadJSON, err := json.Marshal(input.payload)
	if err != nil {
		return storedEvent{}, err
	}
	metadataJSON, err := json.Marshal(input.metadata)
	if err != nil {
		return storedEvent{}, err
	}
	row := storedEvent{}
	err = a.db.QueryRow(ctx, `
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
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
      on conflict (idempotency_key)
        where idempotency_key is not null
        do nothing
      returning
        id,
        event_id,
        event_type,
        event_version,
        aggregate_type,
        aggregate_id,
        aggregate_version,
        payload::text,
        metadata::text,
        idempotency_key,
        occurred_at
    `,
		input.eventID,
		input.eventType,
		input.eventVersion,
		input.aggregateType,
		input.aggregateID,
		input.aggregateVersion,
		string(payloadJSON),
		string(metadataJSON),
		input.idempotencyKey,
		input.occurredAt,
	).Scan(
		&row.ID,
		&row.EventID,
		&row.EventType,
		&row.EventVersion,
		&row.AggregateType,
		&row.AggregateID,
		&row.AggregateVersion,
		&row.PayloadJSON,
		&row.MetadataJSON,
		&row.IdempotencyKey,
		&row.OccurredAt,
	)
	if err == nil {
		return row, nil
	}
	if input.idempotencyKey == nil || input.idempotencyKey != nil && *input.idempotencyKey == "" || !errors.Is(err, pgx.ErrNoRows) {
		return storedEvent{}, err
	}
	return a.readEventByIdempotencyKey(ctx, *input.idempotencyKey)
}

func (a *app) readEventByIdempotencyKey(ctx context.Context, idempotencyKey string) (storedEvent, error) {
	row := storedEvent{}
	err := a.db.QueryRow(ctx, `
      select
        id,
        event_id,
        event_type,
        event_version,
        aggregate_type,
        aggregate_id,
        aggregate_version,
        payload::text,
        metadata::text,
        idempotency_key,
        occurred_at
      from event_store
      where idempotency_key = $1
      limit 1
    `, idempotencyKey).Scan(
		&row.ID,
		&row.EventID,
		&row.EventType,
		&row.EventVersion,
		&row.AggregateType,
		&row.AggregateID,
		&row.AggregateVersion,
		&row.PayloadJSON,
		&row.MetadataJSON,
		&row.IdempotencyKey,
		&row.OccurredAt,
	)
	if err != nil {
		return storedEvent{}, err
	}
	row.WasReplay = true
	return row, nil
}

func (a *app) readCheckoutProjection(ctx context.Context, checkoutIntentID string) (checkoutIntentResponse, error) {
	row := checkoutProjectionRow{}
	err := a.db.QueryRow(ctx, `
      select
        checkout_intent_id,
        buyer_id,
        status,
        items::text,
        payment_id::text,
        order_id::text,
        rejection_reason,
        cancellation_reason,
        aggregate_version,
        last_event_id,
        updated_at
      from checkout_intent_projection
      where checkout_intent_id = $1
      limit 1
    `, checkoutIntentID).Scan(
		&row.CheckoutIntentID,
		&row.BuyerID,
		&row.Status,
		&row.ItemsJSON,
		&row.PaymentID,
		&row.OrderID,
		&row.RejectionReason,
		&row.CancellationReason,
		&row.AggregateVersion,
		&row.LastEventID,
		&row.UpdatedAt,
	)
	if err != nil {
		return checkoutIntentResponse{}, err
	}
	items := []checkoutItem{}
	if err := json.Unmarshal(row.ItemsJSON, &items); err != nil {
		return checkoutIntentResponse{}, err
	}
	return checkoutIntentResponse{
		CheckoutIntentID:   row.CheckoutIntentID,
		BuyerID:            row.BuyerID,
		Status:             row.Status,
		Items:              items,
		PaymentID:          row.PaymentID,
		OrderID:            row.OrderID,
		RejectionReason:    row.RejectionReason,
		CancellationReason: row.CancellationReason,
		AggregateVersion:   row.AggregateVersion,
		LastEventID:        row.LastEventID,
		UpdatedAt:          row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (a *app) readProducts(ctx context.Context) ([]productResponse, error) {
	rows, err := a.db.Query(ctx, `
      select
        product.product_id,
        product.name as product_name,
        product.description,
        sku.sku_id,
        sku.sku_code,
        sku.price_amount_minor,
        sku.currency,
        sku.seckill_candidate,
        sku.seckill_enabled,
        sku.seckill_stock_limit,
        sku.seckill_default_stock,
        sku_inventory_projection.on_hand,
        sku_inventory_projection.reserved,
        sku_inventory_projection.sold,
        sku_inventory_projection.available,
        sku_inventory_projection.aggregate_version as inventory_aggregate_version,
        sku_inventory_projection.last_event_id as inventory_last_event_id,
        sku_inventory_projection.updated_at as inventory_updated_at,
        sku.attributes::text
      from product
      join sku on sku.product_id = product.product_id
      left join sku_inventory_projection on sku_inventory_projection.sku_id = sku.sku_id
      where product.status = 'active'
        and sku.status = 'active'
      order by product.product_id, sku.sku_id
    `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	products := []productResponse{}
	for rows.Next() {
		row, err := scanCatalogProductRow(rows)
		if err != nil {
			return nil, err
		}
		products = append(products, mapCatalogProductRow(row))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return products, nil
}

func (a *app) readProductBySlug(ctx context.Context, slug string) (productResponse, error) {
	rows, err := a.db.Query(ctx, `
      select
        product.product_id,
        product.name as product_name,
        product.description,
        sku.sku_id,
        sku.sku_code,
        sku.price_amount_minor,
        sku.currency,
        sku.seckill_candidate,
        sku.seckill_enabled,
        sku.seckill_stock_limit,
        sku.seckill_default_stock,
        sku_inventory_projection.on_hand,
        sku_inventory_projection.reserved,
        sku_inventory_projection.sold,
        sku_inventory_projection.available,
        sku_inventory_projection.aggregate_version as inventory_aggregate_version,
        sku_inventory_projection.last_event_id as inventory_last_event_id,
        sku_inventory_projection.updated_at as inventory_updated_at,
        sku.attributes::text
      from product
      join sku on sku.product_id = product.product_id
      left join sku_inventory_projection on sku_inventory_projection.sku_id = sku.sku_id
      where product.status = 'active'
        and sku.status = 'active'
        and coalesce(sku.attributes->>'slug', product.product_id) = $1
      limit 1
    `, slug)
	if err != nil {
		return productResponse{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return productResponse{}, pgx.ErrNoRows
	}
	row, err := scanCatalogProductRow(rows)
	if err != nil {
		return productResponse{}, err
	}
	if err := rows.Err(); err != nil {
		return productResponse{}, err
	}
	return mapCatalogProductRow(row), nil
}

func (a *app) readCheckoutComplete(ctx context.Context, checkoutIntentID string) (checkoutCompleteResponse, error) {
	checkout, err := a.readCheckoutProjection(ctx, checkoutIntentID)
	if err != nil {
		return checkoutCompleteResponse{}, err
	}

	var commandID *string
	var commandStatus *string
	err = a.db.QueryRow(ctx, `
      select command_id, status
      from command_status
      where checkout_intent_id = $1
      order by updated_at desc
      limit 1
    `, checkoutIntentID).Scan(&commandID, &commandStatus)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return checkoutCompleteResponse{}, err
	}

	return checkoutCompleteResponse{
		CheckoutIntentID:   checkout.CheckoutIntentID,
		CommandID:          commandID,
		CommandStatus:      commandStatus,
		Status:             checkout.Status,
		OrderID:            checkout.OrderID,
		PaymentID:          checkout.PaymentID,
		RejectionReason:    checkout.RejectionReason,
		CancellationReason: checkout.CancellationReason,
		UpdatedAt:          checkout.UpdatedAt,
	}, nil
}

func (a *app) readAdminDashboard(ctx context.Context) (adminDashboardResponse, error) {
	products, err := a.readAdminProducts(ctx)
	if err != nil {
		return adminDashboardResponse{}, err
	}
	checkoutSummary, err := a.readAdminCheckoutSummary(ctx)
	if err != nil {
		return adminDashboardResponse{}, err
	}
	checkouts, err := a.readAdminCheckouts(ctx)
	if err != nil {
		return adminDashboardResponse{}, err
	}
	checkpoints, err := a.readAdminCheckpoints(ctx)
	if err != nil {
		return adminDashboardResponse{}, err
	}
	return adminDashboardResponse{
		Products:        products,
		CheckoutSummary: checkoutSummary,
		Checkouts:       checkouts,
		Checkpoints:     checkpoints,
		RefreshedAt:     time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func (a *app) readAdminProducts(ctx context.Context) ([]adminProductResponse, error) {
	rows, err := a.db.Query(ctx, `
    select
      product.product_id,
      product.name as product_name,
      product.status as product_status,
      sku.sku_id,
      sku.sku_code,
      sku.name as sku_name,
      sku.status as sku_status,
      sku.price_amount_minor,
      sku.currency,
      sku.seckill_candidate,
      sku.seckill_enabled,
      sku.seckill_stock_limit,
      sku.seckill_default_stock,
      sku_inventory_projection.on_hand,
      sku_inventory_projection.reserved,
      sku_inventory_projection.sold,
      sku_inventory_projection.available,
      sku_inventory_projection.last_event_id as inventory_last_event_id,
      sku_inventory_projection.aggregate_version as inventory_aggregate_version,
      coalesce(seckill_summary.reserved_count, 0) as seckill_reserved_count,
      coalesce(seckill_summary.rejected_count, 0) as seckill_rejected_count,
      seckill_summary.last_processed_at as seckill_last_processed_at
    from product
    join sku on sku.product_id = product.product_id
    left join sku_inventory_projection on sku_inventory_projection.sku_id = sku.sku_id
    left join lateral (
      select
        count(*) filter (where status = 'reserved') as reserved_count,
        count(*) filter (where status = 'rejected') as rejected_count,
        max(updated_at) as last_processed_at
      from seckill_command_result
      where seckill_command_result.sku_id = sku.sku_id
    ) as seckill_summary on true
    order by product.product_id, sku.sku_id
  `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	products := []adminProductResponse{}
	for rows.Next() {
		var row adminProductRow
		if err := rows.Scan(
			&row.ProductID,
			&row.ProductName,
			&row.ProductStatus,
			&row.SkuID,
			&row.SkuCode,
			&row.SkuName,
			&row.SkuStatus,
			&row.PriceAmountMinor,
			&row.Currency,
			&row.SeckillCandidate,
			&row.SeckillEnabled,
			&row.SeckillStockLimit,
			&row.SeckillDefaultStock,
			&row.OnHand,
			&row.Reserved,
			&row.Sold,
			&row.Available,
			&row.InventoryLastEventID,
			&row.InventoryAggregateVersion,
			&row.SeckillReservedCount,
			&row.SeckillRejectedCount,
			&row.SeckillLastProcessedAt,
		); err != nil {
			return nil, err
		}
		var lastProcessedAt *string
		if row.SeckillLastProcessedAt != nil {
			value := row.SeckillLastProcessedAt.UTC().Format(time.RFC3339Nano)
			lastProcessedAt = &value
		}
		products = append(products, adminProductResponse{
			ProductID:                 row.ProductID,
			ProductName:               row.ProductName,
			ProductStatus:             row.ProductStatus,
			SkuID:                     row.SkuID,
			SkuCode:                   row.SkuCode,
			SkuName:                   row.SkuName,
			SkuStatus:                 row.SkuStatus,
			PriceAmountMinor:          row.PriceAmountMinor,
			Currency:                  row.Currency,
			OnHand:                    row.OnHand,
			Reserved:                  row.Reserved,
			Sold:                      row.Sold,
			Available:                 row.Available,
			InventoryLastEventID:      row.InventoryLastEventID,
			InventoryAggregateVersion: row.InventoryAggregateVersion,
			SeckillCandidate:          row.SeckillCandidate,
			SeckillEnabled:            row.SeckillEnabled,
			SeckillStockLimit:         row.SeckillStockLimit,
			SeckillDefaultStock:       row.SeckillDefaultStock,
			SeckillReservedCount:      row.SeckillReservedCount,
			SeckillRejectedCount:      row.SeckillRejectedCount,
			SeckillLastProcessedAt:    lastProcessedAt,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return products, nil
}

func (a *app) readAdminCheckoutSummary(ctx context.Context) (adminCheckoutSummaryResponse, error) {
	var totalCount int
	if err := a.db.QueryRow(ctx, `select count(*) from checkout_intent_projection`).Scan(&totalCount); err != nil {
		return adminCheckoutSummaryResponse{}, err
	}
	rows, err := a.db.Query(ctx, `
      select status, count(*) as count
      from checkout_intent_projection
      group by status
      order by status
    `)
	if err != nil {
		return adminCheckoutSummaryResponse{}, err
	}
	defer rows.Close()
	statusCounts := []adminCheckoutStatusCountResponse{}
	for rows.Next() {
		row := adminCheckoutStatusCountResponse{}
		if err := rows.Scan(&row.Status, &row.Count); err != nil {
			return adminCheckoutSummaryResponse{}, err
		}
		statusCounts = append(statusCounts, row)
	}
	if err := rows.Err(); err != nil {
		return adminCheckoutSummaryResponse{}, err
	}
	return adminCheckoutSummaryResponse{
		DisplayedLimit: 25,
		TotalCount:     totalCount,
		StatusCounts:   statusCounts,
	}, nil
}

func (a *app) readAdminCheckouts(ctx context.Context) ([]adminCheckoutResponse, error) {
	rows, err := a.db.Query(ctx, `
      select
        checkout_intent_id,
        buyer_id,
        status,
        payment_id,
        order_id,
        rejection_reason,
        cancellation_reason,
        aggregate_version,
        last_event_id,
        updated_at
      from checkout_intent_projection
      order by updated_at desc
      limit 25
    `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	checkouts := []adminCheckoutResponse{}
	for rows.Next() {
		var row adminCheckoutRow
		if err := rows.Scan(
			&row.CheckoutIntentID,
			&row.BuyerID,
			&row.Status,
			&row.PaymentID,
			&row.OrderID,
			&row.RejectionReason,
			&row.CancellationReason,
			&row.AggregateVersion,
			&row.LastEventID,
			&row.UpdatedAt,
		); err != nil {
			return nil, err
		}
		checkouts = append(checkouts, adminCheckoutResponse{
			CheckoutIntentID:   row.CheckoutIntentID,
			BuyerID:            row.BuyerID,
			Status:             row.Status,
			PaymentID:          row.PaymentID,
			OrderID:            row.OrderID,
			RejectionReason:    row.RejectionReason,
			CancellationReason: row.CancellationReason,
			AggregateVersion:   row.AggregateVersion,
			LastEventID:        row.LastEventID,
			UpdatedAt:          row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return checkouts, nil
}

func (a *app) readAdminCheckpoints(ctx context.Context) ([]adminCheckpointResponse, error) {
	rows, err := a.db.Query(ctx, `
      select projection_name, last_event_id, updated_at
      from projection_checkpoint
      order by projection_name
    `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	checkpoints := []adminCheckpointResponse{}
	for rows.Next() {
		var row adminCheckpointRow
		if err := rows.Scan(&row.ProjectionName, &row.LastEventID, &row.UpdatedAt); err != nil {
			return nil, err
		}
		checkpoints = append(checkpoints, adminCheckpointResponse{
			ProjectionName: row.ProjectionName,
			LastEventID:    row.LastEventID,
			UpdatedAt:      row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return checkpoints, nil
}

func (a *app) updateSeckillConfig(ctx context.Context, skuID string, enabled bool, stockLimit *int) error {
	_, err := a.db.Exec(ctx, `
      update sku
      set
        seckill_enabled = $2,
        seckill_stock_limit = case when $2 then $3::integer else null end,
        updated_at = now()
      where sku_id = $1
    `, skuID, enabled, stockLimit)
	if err != nil {
		return err
	}
	a.cache.mu.Lock()
	delete(a.cache.entries, skuID)
	a.cache.mu.Unlock()
	return nil
}

func scanCatalogProductRow(rows pgx.Rows) (catalogProductRow, error) {
	var row catalogProductRow
	err := rows.Scan(
		&row.ProductID,
		&row.ProductName,
		&row.Description,
		&row.SkuID,
		&row.SkuCode,
		&row.PriceAmountMinor,
		&row.Currency,
		&row.SeckillCandidate,
		&row.SeckillEnabled,
		&row.SeckillStockLimit,
		&row.SeckillDefaultStock,
		&row.OnHand,
		&row.Reserved,
		&row.Sold,
		&row.Available,
		&row.InventoryAggregateVersion,
		&row.InventoryLastEventID,
		&row.InventoryUpdatedAt,
		&row.AttributesJSON,
	)
	return row, err
}

func mapCatalogProductRow(row catalogProductRow) productResponse {
	attributes := map[string]any{}
	_ = gojson.Unmarshal(row.AttributesJSON, &attributes)
	slug := stringMapValue(attributes, "slug", row.ProductID)
	imageSrc := stringMapValue(attributes, "image", fallbackProductImageURL)
	imageAlt := stringMapValue(attributes, "image_alt", row.ProductName)
	checkoutNote := stringMapValue(attributes, "checkout_note", "projection-backed inventory")
	summary := valueOrDefault(row.Description, "Projection-backed checkout SKU.")
	updatedAt := timePtrString(row.InventoryUpdatedAt)
	projectionLagMs := projectionLag(row.InventoryUpdatedAt)

	return productResponse{
		Slug:             slug,
		Name:             row.ProductName,
		SkuID:            row.SkuID,
		SkuCode:          row.SkuCode,
		Summary:          summary,
		CheckoutNote:     checkoutNote,
		PriceAmountMinor: row.PriceAmountMinor,
		Currency:         row.Currency,
		Available:        intOrZero(row.Available),
		Inventory: productInventoryResponse{
			OnHand:           intOrZero(row.OnHand),
			Reserved:         intOrZero(row.Reserved),
			Sold:             intOrZero(row.Sold),
			Available:        intOrZero(row.Available),
			AggregateVersion: int64OrZero(row.InventoryAggregateVersion),
			LastEventID:      int64OrZero(row.InventoryLastEventID),
			UpdatedAt:        updatedAt,
			ProjectionLagMs:  projectionLagMs,
		},
		Seckill: productSeckillResponse{
			Candidate:    row.SeckillCandidate,
			Enabled:      row.SeckillEnabled,
			StockLimit:   row.SeckillStockLimit,
			DefaultStock: row.SeckillDefaultStock,
		},
		Image: productImageResponse{
			Src: imageSrc,
			Alt: imageAlt,
		},
	}
}

func (a *app) processProjectionBatch(ctx context.Context, projectionName string, batchSize int) (projectionProcessResult, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return projectionProcessResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var locked bool
	if err := tx.QueryRow(ctx, "select pg_try_advisory_xact_lock($1)", projectionLockKey).Scan(&locked); err != nil {
		return projectionProcessResult{}, err
	}
	var checkpoint int64
	if err := tx.QueryRow(ctx, "select coalesce(last_event_id, 0) from projection_checkpoint where projection_name = $1 for update", projectionName).Scan(&checkpoint); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return projectionProcessResult{}, err
	}
	if !locked {
		return projectionProcessResult{Locked: false, ProcessedEvents: 0, LastEventID: checkpoint}, nil
	}

	rows, err := tx.Query(ctx, `
      select
        id,
        event_id,
        event_type,
        event_version,
        aggregate_type,
        aggregate_id,
        aggregate_version,
        payload::text,
        metadata::text,
        idempotency_key,
        occurred_at
      from event_store
      where id > $1
      order by id asc
      limit $2
    `, checkpoint, batchSize)
	if err != nil {
		return projectionProcessResult{}, err
	}

	events := make([]storedEvent, 0, batchSize)
	for rows.Next() {
		event := storedEvent{}
		if err := rows.Scan(
			&event.ID,
			&event.EventID,
			&event.EventType,
			&event.EventVersion,
			&event.AggregateType,
			&event.AggregateID,
			&event.AggregateVersion,
			&event.PayloadJSON,
			&event.MetadataJSON,
			&event.IdempotencyKey,
			&event.OccurredAt,
		); err != nil {
			rows.Close()
			return projectionProcessResult{}, err
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return projectionProcessResult{}, err
	}
	rows.Close()

	processed := 0
	lastEventID := checkpoint
	for _, event := range events {
		if err := applyProjectionEvent(ctx, tx, event); err != nil {
			return projectionProcessResult{}, fmt.Errorf("apply projection event %s(%d): %w", event.EventType, event.ID, err)
		}
		processed++
		lastEventID = event.ID
	}

	if _, err := tx.Exec(ctx, `
      insert into projection_checkpoint (projection_name, last_event_id, updated_at)
      values ($1, $2, now())
      on conflict (projection_name)
      do update set
        last_event_id = excluded.last_event_id,
        updated_at = now()
    `, projectionName, lastEventID); err != nil {
		return projectionProcessResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return projectionProcessResult{}, err
	}
	return projectionProcessResult{
		Locked:          true,
		ProcessedEvents: processed,
		LastEventID:     lastEventID,
	}, nil
}

func applyProjectionEvent(ctx context.Context, tx pgx.Tx, event storedEvent) error {
	switch event.EventType {
	case "CheckoutIntentCreated":
		var payload domainCheckoutIntentCreatedPayload
		if err := json.Unmarshal(event.PayloadJSON, &payload); err != nil {
			return err
		}
		itemsJSON, _ := json.Marshal(payload.Items)
		_, err := tx.Exec(ctx, `
          insert into checkout_intent_projection (
            checkout_intent_id,
            aggregate_version,
            last_event_id,
            buyer_id,
            status,
            items,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, 'queued', $5::jsonb, $6, $6)
          on conflict (checkout_intent_id)
          do update set
            aggregate_version = greatest(checkout_intent_projection.aggregate_version, excluded.aggregate_version),
            last_event_id = excluded.last_event_id,
            buyer_id = excluded.buyer_id,
            status = excluded.status,
            items = excluded.items,
            updated_at = excluded.updated_at
        `, payload.CheckoutIntentID, event.AggregateVersion, event.ID, payload.BuyerID, string(itemsJSON), event.OccurredAt)
		return err
	case "InventoryReservationRequested":
		var payload inventoryReservationRequestedPayload
		if err := json.Unmarshal(event.PayloadJSON, &payload); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
          update checkout_intent_projection
          set status = 'reserving', last_event_id = $2, updated_at = now()
          where checkout_intent_id = $1
            and status not in ('rejected', 'cancelled', 'confirmed', 'expired')
        `, payload.CheckoutIntentID, event.ID)
		return err
	case "InventoryReserved":
		var payload inventoryReservedPayload
		if err := json.Unmarshal(event.PayloadJSON, &payload); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
          update sku_inventory_projection
          set aggregate_version = $2, last_event_id = $3, reserved = reserved + $4, available = available - $4, updated_at = now()
          where sku_id = $1
        `, payload.SkuID, event.AggregateVersion, event.ID, payload.Quantity); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
          update checkout_intent_projection
          set status = 'reserved', last_event_id = $2, updated_at = now()
          where checkout_intent_id = $1
            and status not in ('rejected', 'cancelled', 'confirmed', 'expired')
        `, payload.CheckoutIntentID, event.ID)
		return err
	case "InventoryReservationRejected":
		var payload inventoryRejectedPayload
		if err := json.Unmarshal(event.PayloadJSON, &payload); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
          update checkout_intent_projection
          set status = 'rejected', rejection_reason = $2, last_event_id = $3, updated_at = now()
          where checkout_intent_id = $1
        `, payload.CheckoutIntentID, payload.Reason, event.ID)
		return err
	case "PaymentRequested":
		var payload paymentRequestedPayload
		if err := json.Unmarshal(event.PayloadJSON, &payload); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
          update checkout_intent_projection
          set status = 'pending_payment', payment_id = $2, last_event_id = $3, updated_at = now()
          where checkout_intent_id = $1
        `, payload.CheckoutIntentID, payload.PaymentID, event.ID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
          update order_projection
          set payment_status = 'requested', last_event_id = $2, updated_at = now()
          where checkout_intent_id = $1
        `, payload.CheckoutIntentID, event.ID)
		return err
	case "InventoryReservationReleased":
		var payload inventoryReleasedPayload
		if err := json.Unmarshal(event.PayloadJSON, &payload); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
          update sku_inventory_projection
          set aggregate_version = $2, last_event_id = $3, reserved = reserved - $4, available = available + $4, updated_at = now()
          where sku_id = $1
        `, payload.SkuID, event.AggregateVersion, event.ID, payload.Quantity)
		return err
	case "OrderConfirmed":
		var payload orderConfirmedPayload
		if err := json.Unmarshal(event.PayloadJSON, &payload); err != nil {
			return err
		}
		itemsJSON, _ := json.Marshal(payload.Items)
		if _, err := tx.Exec(ctx, `
          insert into order_projection (
            order_id,
            aggregate_version,
            last_event_id,
            checkout_intent_id,
            buyer_id,
            status,
            payment_status,
            items,
            total_amount_minor,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, $5, 'confirmed', 'succeeded', $6::jsonb, $7, $8, $8)
          on conflict (order_id)
          do update set
            aggregate_version = excluded.aggregate_version,
            last_event_id = excluded.last_event_id,
            status = excluded.status,
            payment_status = excluded.payment_status,
            items = excluded.items,
            total_amount_minor = excluded.total_amount_minor,
            updated_at = excluded.updated_at
        `, payload.OrderID, event.AggregateVersion, event.ID, payload.CheckoutIntentID, payload.BuyerID, string(itemsJSON), payload.TotalAmountMinor, event.OccurredAt); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
          update checkout_intent_projection
          set status = 'confirmed', order_id = $2, last_event_id = $3, updated_at = now()
          where checkout_intent_id = $1
        `, payload.CheckoutIntentID, payload.OrderID, event.ID); err != nil {
			return err
		}
		for _, item := range payload.Items {
			if _, err := tx.Exec(ctx, `
              update sku_inventory_projection
              set last_event_id = $2, reserved = reserved - $3, sold = sold + $3, updated_at = now()
              where sku_id = $1
            `, item.SkuID, event.ID, item.Quantity); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *app) completeDemoCheckout(ctx context.Context, checkoutIntentID string, reqCtx requestContext) (completeDemoCheckoutResponse, error) {
	checkout, err := a.readDemoCheckout(ctx, checkoutIntentID)
	if err != nil {
		return completeDemoCheckoutResponse{}, err
	}
	metadata := eventMetadata{
		RequestID:   reqCtx.requestID,
		TraceID:     reqCtx.traceID,
		Source:      "worker",
		ActorID:     "demo-checkout-completer",
		Traceparent: injectTraceCarrier(ctx)["traceparent"],
		Tracestate:  injectTraceCarrier(ctx)["tracestate"],
		Baggage:     injectTraceCarrier(ctx)["baggage"],
	}

	type reserveOutcome struct {
		eventType string
		reserved  *inventoryReservedPayload
		rejected  *inventoryRejectedPayload
	}
	outcomes := []reserveOutcome{}
	for index, item := range checkout.Items {
		state, err := a.readSkuAggregateState(ctx, item.SkuID)
		if err != nil {
			return completeDemoCheckoutResponse{}, err
		}
		reservationID := uuid.NewString()
		idem := fmt.Sprintf("demo-reserve:%s:%d", checkout.CheckoutIntentID, index)
		requestedAt := time.Now().UTC()
		reqEvent := inventoryReservationRequestedEvent{
			Type:    "InventoryReservationRequested",
			Version: 1,
			Payload: inventoryReservationRequestedPayload{
				CheckoutIntentID: checkout.CheckoutIntentID,
				ReservationID:    reservationID,
				SkuID:            item.SkuID,
				Quantity:         item.Quantity,
			},
		}
		requestedStored, err := a.appendEvent(ctx, eventStoreAppendInput{
			eventID:          uuid.NewString(),
			eventType:        reqEvent.Type,
			eventVersion:     reqEvent.Version,
			aggregateType:    "sku",
			aggregateID:      item.SkuID,
			aggregateVersion: state.aggregateVersion + 1,
			payload:          reqEvent.Payload,
			metadata:         metadata,
			idempotencyKey:   stringPtr(idem + ":requested"),
			occurredAt:       requestedAt,
		})
		if err != nil {
			return completeDemoCheckoutResponse{}, err
		}
		_ = requestedStored

		if state.available < item.Quantity {
			rejected := inventoryRejectedEvent{
				Type:    "InventoryReservationRejected",
				Version: 1,
				Payload: inventoryRejectedPayload{
					CheckoutIntentID: checkout.CheckoutIntentID,
					ReservationID:    reservationID,
					SkuID:            item.SkuID,
					Quantity:         item.Quantity,
					Reason:           "insufficient_inventory",
				},
			}
			if _, err := a.appendEvent(ctx, eventStoreAppendInput{
				eventID:          uuid.NewString(),
				eventType:        rejected.Type,
				eventVersion:     rejected.Version,
				aggregateType:    "sku",
				aggregateID:      item.SkuID,
				aggregateVersion: state.aggregateVersion + 2,
				payload:          rejected.Payload,
				metadata:         metadata,
				idempotencyKey:   stringPtr(idem),
				occurredAt:       time.Now().UTC(),
			}); err != nil {
				return completeDemoCheckoutResponse{}, err
			}
			outcomes = append(outcomes, reserveOutcome{
				eventType: "InventoryReservationRejected",
				rejected:  &rejected.Payload,
			})
			continue
		}

		reserved := inventoryReservedEvent{
			Type:    "InventoryReserved",
			Version: 1,
			Payload: inventoryReservedPayload{
				CheckoutIntentID: checkout.CheckoutIntentID,
				ReservationID:    reservationID,
				SkuID:            item.SkuID,
				Quantity:         item.Quantity,
				ExpiresAt:        time.Now().UTC().Add(15 * time.Minute).Format(time.RFC3339Nano),
			},
		}
		if _, err := a.appendEvent(ctx, eventStoreAppendInput{
			eventID:          uuid.NewString(),
			eventType:        reserved.Type,
			eventVersion:     reserved.Version,
			aggregateType:    "sku",
			aggregateID:      item.SkuID,
			aggregateVersion: state.aggregateVersion + 2,
			payload:          reserved.Payload,
			metadata:         metadata,
			idempotencyKey:   stringPtr(idem),
			occurredAt:       time.Now().UTC(),
		}); err != nil {
			return completeDemoCheckoutResponse{}, err
		}
		outcomes = append(outcomes, reserveOutcome{
			eventType: "InventoryReserved",
			reserved:  &reserved.Payload,
		})
	}

	for _, outcome := range outcomes {
		if outcome.rejected != nil {
			for _, prior := range outcomes {
				if prior.reserved == nil {
					continue
				}
				release := inventoryReleasedEvent{
					Type:    "InventoryReservationReleased",
					Version: 1,
					Payload: inventoryReleasedPayload{
						CheckoutIntentID: checkout.CheckoutIntentID,
						ReservationID:    prior.reserved.ReservationID,
						SkuID:            prior.reserved.SkuID,
						Quantity:         prior.reserved.Quantity,
						Reason:           "cart_reservation_failed",
					},
				}
				state, err := a.readSkuAggregateState(ctx, prior.reserved.SkuID)
				if err != nil {
					return completeDemoCheckoutResponse{}, err
				}
				if _, err := a.appendEvent(ctx, eventStoreAppendInput{
					eventID:          uuid.NewString(),
					eventType:        release.Type,
					eventVersion:     release.Version,
					aggregateType:    "sku",
					aggregateID:      prior.reserved.SkuID,
					aggregateVersion: state.aggregateVersion + 1,
					payload:          release.Payload,
					metadata:         metadata,
					idempotencyKey:   stringPtr(fmt.Sprintf("demo-release:%s:%s", checkout.CheckoutIntentID, prior.reserved.ReservationID)),
					occurredAt:       time.Now().UTC(),
				}); err != nil {
					return completeDemoCheckoutResponse{}, err
				}
			}
			return completeDemoCheckoutResponse{
				CheckoutIntentID: checkout.CheckoutIntentID,
				Status:           "rejected",
				Reason:           &outcome.rejected.Reason,
			}, nil
		}
	}

	total := 0
	for _, item := range checkout.Items {
		total += item.UnitPriceAmountMinor * item.Quantity
	}
	paymentID := uuid.NewString()
	orderID := uuid.NewString()
	payment := paymentRequestedEvent{
		Type:    "PaymentRequested",
		Version: 1,
		Payload: paymentRequestedPayload{
			PaymentID:        paymentID,
			CheckoutIntentID: checkout.CheckoutIntentID,
			Amount:           total,
			IdempotencyKey:   fmt.Sprintf("demo-payment:%s", checkout.CheckoutIntentID),
		},
	}
	if _, err := a.appendEvent(ctx, eventStoreAppendInput{
		eventID:          uuid.NewString(),
		eventType:        payment.Type,
		eventVersion:     payment.Version,
		aggregateType:    "payment",
		aggregateID:      paymentID,
		aggregateVersion: 1,
		payload:          payment.Payload,
		metadata:         metadata,
		idempotencyKey:   stringPtr(payment.Payload.IdempotencyKey),
		occurredAt:       time.Now().UTC(),
	}); err != nil {
		return completeDemoCheckoutResponse{}, err
	}

	order := orderConfirmedEvent{
		Type:    "OrderConfirmed",
		Version: 1,
		Payload: orderConfirmedPayload{
			OrderID:          orderID,
			CheckoutIntentID: checkout.CheckoutIntentID,
			BuyerID:          checkout.BuyerID,
			Items:            checkout.Items,
			TotalAmountMinor: total,
		},
	}
	if _, err := a.appendEvent(ctx, eventStoreAppendInput{
		eventID:          uuid.NewString(),
		eventType:        order.Type,
		eventVersion:     order.Version,
		aggregateType:    "order",
		aggregateID:      orderID,
		aggregateVersion: 1,
		payload:          order.Payload,
		metadata:         metadata,
		idempotencyKey:   stringPtr(fmt.Sprintf("demo-order:%s", checkout.CheckoutIntentID)),
		occurredAt:       time.Now().UTC(),
	}); err != nil {
		return completeDemoCheckoutResponse{}, err
	}

	return completeDemoCheckoutResponse{
		CheckoutIntentID: checkout.CheckoutIntentID,
		Status:           "confirmed",
		OrderID:          &orderID,
		PaymentID:        &paymentID,
	}, nil
}

func (a *app) readDemoCheckout(ctx context.Context, checkoutIntentID string) (checkoutDemoRow, error) {
	row := checkoutDemoRow{}
	var itemsJSON []byte
	err := a.db.QueryRow(ctx, `
      select checkout_intent_id, buyer_id, items::text
      from checkout_intent_projection
      where checkout_intent_id = $1
      limit 1
    `, checkoutIntentID).Scan(&row.CheckoutIntentID, &row.BuyerID, &itemsJSON)
	if err != nil {
		return checkoutDemoRow{}, err
	}
	if err := json.Unmarshal(itemsJSON, &row.Items); err != nil {
		return checkoutDemoRow{}, err
	}
	return row, nil
}

func (a *app) readSkuAggregateState(ctx context.Context, skuID string) (skuAggregateState, error) {
	var onHand int
	if err := a.db.QueryRow(ctx, `
      select on_hand
      from sku_inventory_projection
      where sku_id = $1
      limit 1
    `, skuID).Scan(&onHand); err != nil {
		return skuAggregateState{}, err
	}
	state := skuAggregateState{
		skuID:            skuID,
		onHand:           onHand,
		available:        onHand,
		reservations:     map[string]reservationState{},
		aggregateVersion: 0,
	}
	rows, err := a.db.Query(ctx, `
      select event_type, payload::text
      from event_store
      where aggregate_type = 'sku'
        and aggregate_id = $1
      order by aggregate_version asc
    `, skuID)
	if err != nil {
		return skuAggregateState{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var eventType string
		var payloadJSON []byte
		if err := rows.Scan(&eventType, &payloadJSON); err != nil {
			return skuAggregateState{}, err
		}
		switch eventType {
		case "InventoryReserved":
			var payload inventoryReservedPayload
			if err := json.Unmarshal(payloadJSON, &payload); err != nil {
				return skuAggregateState{}, err
			}
			state.reserved += payload.Quantity
			state.available -= payload.Quantity
			state.aggregateVersion++
			state.reservations[payload.ReservationID] = reservationState{
				checkoutIntentID: payload.CheckoutIntentID,
				skuID:            payload.SkuID,
				quantity:         payload.Quantity,
				status:           "reserved",
			}
		case "InventoryReservationReleased":
			var payload inventoryReleasedPayload
			if err := json.Unmarshal(payloadJSON, &payload); err != nil {
				return skuAggregateState{}, err
			}
			if reservation, ok := state.reservations[payload.ReservationID]; ok && reservation.status == "reserved" {
				state.reserved -= payload.Quantity
				state.available += payload.Quantity
				reservation.status = "released"
				state.reservations[payload.ReservationID] = reservation
			}
			state.aggregateVersion++
		case "OrderConfirmed":
			var payload orderConfirmedPayload
			if err := json.Unmarshal(payloadJSON, &payload); err != nil {
				return skuAggregateState{}, err
			}
			for _, item := range payload.Items {
				if item.SkuID == skuID {
					state.reserved -= item.Quantity
					state.sold += item.Quantity
				}
			}
			for id, reservation := range state.reservations {
				if reservation.checkoutIntentID == payload.CheckoutIntentID {
					reservation.status = "sold"
					state.reservations[id] = reservation
				}
			}
			state.aggregateVersion++
		case "InventoryReservationRejected", "InventoryReservationRequested":
			state.aggregateVersion++
		}
	}
	if err := rows.Err(); err != nil {
		return skuAggregateState{}, err
	}
	return state, nil
}

func ensureBuyIntentCommandStream(ctx context.Context, js nats.JetStreamContext, cfg config) error {
	if _, err := js.StreamInfo(cfg.natsStreamName); err == nil {
		return nil
	}
	_, err := js.AddStream(&nats.StreamConfig{
		Name:      cfg.natsStreamName,
		Subjects:  uniqueStrings(cfg.natsSubject, cfg.natsRetrySubject, cfg.natsDLQSubject),
		Storage:   nats.FileStorage,
		Retention: nats.LimitsPolicy,
	})
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "already in use") {
		return err
	}
	return nil
}

func validateCreateCheckoutIntentRequest(body requestBody) error {
	if strings.TrimSpace(body.BuyerID) == "" {
		return errors.New("buyerId is required.")
	}
	if len(body.Items) == 0 {
		return errors.New("items must be a non-empty array.")
	}
	if strings.TrimSpace(body.IdempotencyKey) == "" && body.IdempotencyKey != "" {
		return errors.New("idempotencyKey must be non-empty when provided.")
	}
	for _, item := range body.Items {
		if strings.TrimSpace(item.SkuID) == "" {
			return errors.New("item.skuId is required.")
		}
		if item.Quantity <= 0 {
			return errors.New("item.quantity must be a positive integer.")
		}
		if item.UnitPriceAmountMinor < 0 {
			return errors.New("item.unitPriceAmountMinor must be a non-negative integer.")
		}
		if len(strings.TrimSpace(item.Currency)) != 3 {
			return errors.New("item.currency is required.")
		}
	}
	return nil
}

func decodeRequestBody[T any](r *http.Request) (T, error) {
	var body T
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return body, err
	}
	if err := gojson.Unmarshal(data, &body); err != nil {
		return body, err
	}
	return body, nil
}

func decodeLooseBody(r *http.Request) (map[string]any, error) {
	if r.Body == nil {
		return map[string]any{}, nil
	}
	value := map[string]any{}
	if err := json.NewDecoder(r.Body).Decode(&value); err != nil && !errors.Is(err, io.EOF) {
		return map[string]any{}, nil
	}
	return value, nil
}

func decodeHertzBody[T any](c *hertzapp.RequestContext) (T, error) {
	var body T
	if err := gojson.Unmarshal(c.Request.Body(), &body); err != nil {
		return body, err
	}
	return body, nil
}

func requestContextFromRequest(ctx context.Context, r *http.Request) requestContext {
	requestID := strings.TrimSpace(r.Header.Get("x-request-id"))
	if requestID == "" {
		requestID = uuid.NewString()
	}
	traceID := strings.TrimSpace(r.Header.Get("x-trace-id"))
	if traceID == "" {
		traceID = traceIDFromContext(ctx)
	}
	if traceID == "" {
		traceID = requestID
	}
	return requestContext{
		requestID: requestID,
		traceID:   traceID,
	}
}

func requestContextFromHertz(ctx context.Context, c *hertzapp.RequestContext) requestContext {
	requestID := strings.TrimSpace(string(c.Request.Header.Peek("x-request-id")))
	if requestID == "" {
		requestID = uuid.NewString()
	}
	traceID := strings.TrimSpace(string(c.Request.Header.Peek("x-trace-id")))
	if traceID == "" {
		traceID = traceIDFromContext(ctx)
	}
	if traceID == "" {
		traceID = requestID
	}
	return requestContext{
		requestID: requestID,
		traceID:   traceID,
	}
}

func traceIDFromContext(ctx context.Context) string {
	span := trace.SpanFromContext(ctx)
	if !span.SpanContext().IsValid() {
		return ""
	}
	return span.SpanContext().TraceID().String()
}

func injectTraceCarrier(ctx context.Context) map[string]string {
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	return map[string]string(carrier)
}

func writeJSON(w http.ResponseWriter, status int, reqCtx requestContext, body any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("x-request-id", reqCtx.requestID)
	w.Header().Set("x-trace-id", reqCtx.traceID)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, reqCtx requestContext, status int, message string) {
	writeJSON(w, status, reqCtx, errorResponse{
		Error:     message,
		RequestID: reqCtx.requestID,
	})
}

func writeJSONHertz(c *hertzapp.RequestContext, status int, reqCtx requestContext, body any) {
	c.Response.Header.Set("content-type", "application/json")
	c.Response.Header.Set("x-request-id", reqCtx.requestID)
	c.Response.Header.Set("x-trace-id", reqCtx.traceID)
	c.SetStatusCode(status)
	payload, err := json.Marshal(body)
	if err != nil {
		c.Response.ResetBody()
		c.SetStatusCode(consts.StatusInternalServerError)
		c.Response.SetBodyString(`{"error":"response encoding failed"}`)
		return
	}
	c.Response.SetBodyRaw(payload)
}

func writeErrorHertz(c *hertzapp.RequestContext, reqCtx requestContext, status int, message string) {
	writeJSONHertz(c, status, reqCtx, errorResponse{
		Error:     message,
		RequestID: reqCtx.requestID,
	})
}

func withCORS(cfg config, next http.Handler) http.Handler {
	allowedOrigins := map[string]struct{}{}
	allowAnyOrigin := false
	for _, origin := range cfg.corsAllowedOrigins {
		if origin == "*" {
			allowAnyOrigin = true
			continue
		}
		allowedOrigins[origin] = struct{}{}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if allowAnyOrigin {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else if origin != "" {
			if _, ok := allowedOrigins[origin]; ok {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Idempotency-Key,X-Request-Id,X-Trace-Id")
		w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id,X-Trace-Id")
		w.Header().Set("Access-Control-Max-Age", "600")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) hertzCORS() hertzapp.HandlerFunc {
	allowedOrigins := map[string]struct{}{}
	allowAnyOrigin := false
	for _, origin := range a.cfg.corsAllowedOrigins {
		if origin == "*" {
			allowAnyOrigin = true
			continue
		}
		allowedOrigins[origin] = struct{}{}
	}

	return func(_ context.Context, c *hertzapp.RequestContext) {
		origin := strings.TrimSpace(string(c.Request.Header.Peek("Origin")))
		if allowAnyOrigin {
			c.Response.Header.Set("Access-Control-Allow-Origin", "*")
		} else if origin != "" {
			if _, ok := allowedOrigins[origin]; ok {
				c.Response.Header.Set("Access-Control-Allow-Origin", origin)
				c.Response.Header.Set("Vary", "Origin")
			}
		}
		c.Response.Header.Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		c.Response.Header.Set("Access-Control-Allow-Headers", "Content-Type,Idempotency-Key,X-Request-Id,X-Trace-Id")
		c.Response.Header.Set("Access-Control-Expose-Headers", "X-Request-Id,X-Trace-Id")
		c.Response.Header.Set("Access-Control-Max-Age", "600")

		if string(c.Method()) == http.MethodOptions {
			c.AbortWithStatus(consts.StatusNoContent)
			return
		}
		c.Next(context.Background())
	}
}

func toCheckoutItems(items []requestItem) []checkoutItem {
	out := make([]checkoutItem, 0, len(items))
	for _, item := range items {
		out = append(out, checkoutItem{
			SkuID:                item.SkuID,
			Quantity:             item.Quantity,
			UnitPriceAmountMinor: item.UnitPriceAmountMinor,
			Currency:             item.Currency,
		})
	}
	return out
}

func selectPrimaryBucket(stableKey string, bucketCount int) int {
	hash := fnv1a32(stableKey)
	return hash % bucketCount
}

func buildProcessingKey(skuID string, bucketID int) string {
	return fmt.Sprintf("%s#%02d", skuID, bucketID)
}

func readForcedSeckillSKUs() map[string]int {
	raw := strings.TrimSpace(os.Getenv("GO_BACKEND_FORCE_SECKILL_SKUS"))
	if raw == "" {
		return nil
	}

	defaultStockLimit := envInt("GO_BACKEND_FORCE_SECKILL_STOCK_LIMIT", 0)
	configs := make(map[string]int)
	for _, token := range strings.Split(raw, ",") {
		entry := strings.TrimSpace(token)
		if entry == "" {
			continue
		}

		skuID := entry
		stockLimit := defaultStockLimit
		if strings.Contains(entry, ":") {
			parts := strings.SplitN(entry, ":", 2)
			skuID = strings.TrimSpace(parts[0])
			if parsed, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil && parsed > 0 {
				stockLimit = parsed
			}
		}

		if skuID == "" || stockLimit <= 0 {
			continue
		}
		configs[skuID] = stockLimit
	}

	if len(configs) == 0 {
		return nil
	}
	return configs
}

func normalizeSeckillPartition(bucketID int) int32 {
	if bucketID < 0 {
		return 0
	}
	return int32(bucketID)
}

func ensureKafkaTopics(ctx context.Context, client *kgo.Client, topics []string, partitions int) error {
	req := kmsg.NewPtrCreateTopicsRequest()
	req.TimeoutMillis = 5000

	for _, topic := range topics {
		if strings.TrimSpace(topic) == "" {
			continue
		}
		reqTopic := kmsg.NewCreateTopicsRequestTopic()
		reqTopic.Topic = topic
		reqTopic.NumPartitions = int32(partitions)
		reqTopic.ReplicationFactor = 1
		req.Topics = append(req.Topics, reqTopic)
	}

	if len(req.Topics) == 0 {
		return nil
	}

	resp, err := req.RequestWith(ctx, client)
	if err != nil {
		return err
	}
	for _, topic := range resp.Topics {
		err = kerr.ErrorForCode(topic.ErrorCode)
		if err == nil || errors.Is(err, kerr.TopicAlreadyExists) {
			continue
		}
		return fmt.Errorf("create topic %s: %w", topic.Topic, err)
	}
	return nil
}

func fnv1a32(value string) int {
	const (
		offset32 = 2166136261
		prime32  = 16777619
	)
	hash := uint32(offset32)
	for i := 0; i < len(value); i++ {
		hash ^= uint32(value[i])
		hash *= prime32
	}
	return int(hash)
}

func setupTelemetry(serviceName string, endpoint string, enabled bool) (func(context.Context) error, error) {
	if !enabled {
		return func(context.Context) error { return nil }, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpoint(strings.TrimPrefix(strings.TrimPrefix(endpoint, "http://"), "https://")), otlptracehttp.WithInsecure())
	if err != nil {
		return nil, err
	}
	res, err := resource.New(ctx, resource.WithAttributes(semconv.ServiceName(serviceName)))
	if err != nil {
		return nil, err
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter), sdktrace.WithResource(res))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	return provider.Shutdown, nil
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func uniqueStrings(values ...string) []string {
	seen := map[string]struct{}{}
	result := []string{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func kafkaCompressionCodec(value string) kgo.CompressionCodec {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "gzip":
		return kgo.GzipCompression()
	case "snappy":
		return kgo.SnappyCompression()
	case "lz4":
		return kgo.Lz4Compression()
	case "zstd":
		return kgo.ZstdCompression()
	default:
		return kgo.NoCompression()
	}
}

func envDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func requiredEnv(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func envInt(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func intValue(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return fallback
	}
}

func stringValue(value any, fallback string) string {
	typed, ok := value.(string)
	if !ok || strings.TrimSpace(typed) == "" {
		return fallback
	}
	return typed
}

func stringMapValue(values map[string]any, key string, fallback string) string {
	if values == nil {
		return fallback
	}
	return stringValue(values[key], fallback)
}

func ternaryStatus(condition bool, whenTrue int, whenFalse int) int {
	if condition {
		return whenTrue
	}
	return whenFalse
}

func stringPtr(value string) *string {
	return &value
}

func valueOrDefault(value *string, fallback string) string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return fallback
	}
	return *value
}

func intOrZero(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func int64OrZero(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func timePtrString(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

func projectionLag(value *time.Time) *int64 {
	if value == nil {
		return nil
	}
	lag := time.Now().UnixMilli() - value.UnixMilli()
	return &lag
}

const fallbackProductImageURL = "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=1400&q=80"
