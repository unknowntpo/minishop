package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

type config struct {
	addr              string
	databaseURL       string
	databasePoolMax   int
	kafkaBrokers      []string
	kafkaRequestTopic string
	kafkaBucketCount  int
	kafkaMaxProbe     int
	kafkaClientID     string
	kafkaBatchSize    int
	kafkaLingerMs     int
	cacheTTL          time.Duration
	serviceName       string
	otlpEndpoint      string
	otelEnabled       bool
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

type acceptResponse struct {
	CommandID     string `json:"commandId"`
	CorrelationID string `json:"correlationId"`
	Status        string `json:"status"`
}

type errorResponse struct {
	Error     string `json:"error"`
	RequestID string `json:"requestId"`
}

type seckillBuyIntentRequest struct {
	SkuID             string           `json:"sku_id"`
	Quantity          int              `json:"quantity"`
	SeckillStockLimit int              `json:"seckill_stock_limit"`
	BucketCount       int              `json:"bucket_count"`
	PrimaryBucketID   int              `json:"primary_bucket_id"`
	BucketID          int              `json:"bucket_id"`
	Attempt           int              `json:"attempt"`
	MaxProbe          int              `json:"max_probe"`
	ProcessingKey     string           `json:"processing_key"`
	Command           buyIntentCommand `json:"command"`
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

type checkoutItem struct {
	SkuID                string `json:"sku_id"`
	Quantity             int    `json:"quantity"`
	UnitPriceAmountMinor int    `json:"unit_price_amount_minor"`
	Currency             string `json:"currency"`
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

type cachedSeckillConfig struct {
	enabled     bool
	stockLimit  int
	expiresAtMs int64
}

type skuConfigCache struct {
	mu      sync.RWMutex
	entries map[string]cachedSeckillConfig
}

type app struct {
	cfg      config
	db       *sql.DB
	writer   *kafka.Writer
	cache    *skuConfigCache
	tracer   trace.Tracer
	shutdown func(context.Context) error
}

var (
	errUnsupportedCart = errors.New("mixed cart or multi-item seckill checkout is not supported")
	errNonSeckillSKU   = errors.New("sku is not configured for seckill ingress")
)

func main() {
	cfg := readConfig()
	flush, err := setupTelemetry(cfg)
	if err != nil {
		log.Fatalf("setup telemetry: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = flush(ctx)
	}()

	db := sql.OpenDB(stdlib.GetConnector(*mustParsePgxConfig(cfg.databaseURL)))
	db.SetMaxOpenConns(cfg.databasePoolMax)
	db.SetMaxIdleConns(cfg.databasePoolMax)
	db.SetConnMaxLifetime(5 * time.Minute)

	writer := &kafka.Writer{
		Addr:         kafka.TCP(cfg.kafkaBrokers...),
		Topic:        cfg.kafkaRequestTopic,
		Balancer:     &kafka.LeastBytes{},
		BatchTimeout: time.Duration(cfg.kafkaLingerMs) * time.Millisecond,
		BatchSize:    cfg.kafkaBatchSize,
		RequiredAcks: kafka.RequireAll,
		Async:        false,
		Transport: &kafka.Transport{
			ClientID: cfg.kafkaClientID,
		},
	}

	instance := &app{
		cfg:    cfg,
		db:     db,
		writer: writer,
		cache: &skuConfigCache{
			entries: map[string]cachedSeckillConfig{},
		},
		tracer: otel.Tracer("go-seckill-ingress"),
	}

	if err := instance.warmUp(context.Background()); err != nil {
		log.Fatalf("warm up go-seckill-ingress: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/api/buy-intents", otelhttp.NewHandler(http.HandlerFunc(instance.handleBuyIntents), "POST /api/buy-intents"))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	server := &http.Server{
		Addr:              cfg.addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("go-seckill-ingress listening on %s", cfg.addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	_ = writer.Close()
	_ = db.Close()
}

func readConfig() config {
	return config{
		addr:              envDefault("GO_SECKILL_INGRESS_ADDR", ":3000"),
		databaseURL:       requiredEnv("DATABASE_URL"),
		databasePoolMax:   envInt("DATABASE_POOL_MAX", 4),
		kafkaBrokers:      splitCSV(envDefault("KAFKA_BROKERS", "redpanda:9092")),
		kafkaRequestTopic: envDefault("KAFKA_SECKILL_REQUEST_TOPIC", "inventory.seckill.requested"),
		kafkaBucketCount:  envInt("KAFKA_SECKILL_BUCKET_COUNT", 16),
		kafkaMaxProbe:     envInt("KAFKA_SECKILL_MAX_PROBE", 4),
		kafkaClientID:     envDefault("KAFKA_CLIENT_ID", "minishop-go-seckill-ingress"),
		kafkaBatchSize:    envInt("KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES", 10000),
		kafkaLingerMs:     envInt("KAFKA_SECKILL_CLIENT_LINGER_MS", 1),
		cacheTTL:          time.Duration(envInt("KAFKA_SECKILL_CONFIG_CACHE_TTL_MS", 60000)) * time.Millisecond,
		serviceName:       envDefault("OTEL_SERVICE_NAME", "go-seckill-ingress"),
		otlpEndpoint:      envDefault("OTEL_EXPORTER_OTLP_ENDPOINT", "http://tempo:4318"),
		otelEnabled:       envDefault("OTEL_ENABLED", "1") != "0",
	}
}

func (a *app) warmUp(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := a.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	_ = conn.Close()

	dialer := &kafka.Dialer{
		ClientID: a.cfg.kafkaClientID,
		Timeout:  5 * time.Second,
	}
	connKafka, err := dialer.DialContext(ctx, "tcp", a.cfg.kafkaBrokers[0])
	if err != nil {
		return fmt.Errorf("kafka dial: %w", err)
	}
	return connKafka.Close()
}

func (a *app) handleBuyIntents(w http.ResponseWriter, r *http.Request) {
	ctx, span := a.tracer.Start(r.Context(), "buy_intent.accept_go_seckill")
	defer span.End()

	requestID := strings.TrimSpace(r.Header.Get("x-request-id"))
	if requestID == "" {
		requestID = uuid.NewString()
	}

	var body requestBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid_json")
		writeError(w, requestID, traceIDFromContext(ctx), http.StatusBadRequest, "Request body must be valid JSON.")
		return
	}

	_, validateSpan := a.tracer.Start(ctx, "buy_intent.validate_request")
	err := validateRequest(body)
	validateSpan.SetAttributes(
		attribute.Int("buy_intent.item_count", len(body.Items)),
		attribute.String("buy_intent.buyer_id", body.BuyerID),
	)
	if err != nil {
		validateSpan.RecordError(err)
		validateSpan.SetStatus(codes.Error, "invalid_request")
		validateSpan.End()
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid_request")
		status := http.StatusBadRequest
		if errors.Is(err, errNonSeckillSKU) {
			status = http.StatusUnprocessableEntity
		}
		writeError(w, requestID, traceIDFromContext(ctx), status, err.Error())
		return
	}
	item := body.Items[0]
	validateSpan.SetAttributes(
		attribute.String("buy_intent.sku_id", item.SkuID),
		attribute.Int("buy_intent.quantity", item.Quantity),
		attribute.Int("buy_intent.unit_price_minor", item.UnitPriceAmountMinor),
		attribute.String("buy_intent.currency", item.Currency),
	)
	validateSpan.End()

	cfg, err := a.readSeckillConfig(ctx, item.SkuID)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "lookup_failed")
		writeError(w, requestID, traceIDFromContext(ctx), http.StatusInternalServerError, "Buy intent command could not be accepted. Please try again.")
		return
	}
	if !cfg.enabled || cfg.stockLimit <= 0 {
		span.SetStatus(codes.Error, "non_seckill_sku")
		writeError(w, requestID, traceIDFromContext(ctx), http.StatusUnprocessableEntity, errNonSeckillSKU.Error())
		return
	}

	commandID := uuid.NewString()
	correlationID := uuid.NewString()
	idempotencyKey := strings.TrimSpace(r.Header.Get("idempotency-key"))
	if idempotencyKey == "" {
		idempotencyKey = strings.TrimSpace(body.IdempotencyKey)
	}
	stableKey := idempotencyKey
	if stableKey == "" {
		stableKey = commandID
	}
	primaryBucketID := selectPrimaryBucket(stableKey, a.cfg.kafkaBucketCount)
	traceCarrier := injectTraceCarrier(ctx)

	buildCtx, buildSpan := a.tracer.Start(ctx, "buy_intent.build_seckill_request")
	buildSpan.SetAttributes(
		attribute.String("buy_intent.command_id", commandID),
		attribute.String("buy_intent.correlation_id", correlationID),
		attribute.String("buy_intent.sku_id", item.SkuID),
		attribute.Int("buy_intent.quantity", item.Quantity),
		attribute.Int("buy_intent.primary_bucket_id", primaryBucketID),
		attribute.Int("buy_intent.bucket_count", a.cfg.kafkaBucketCount),
		attribute.Int("buy_intent.max_probe", a.cfg.kafkaMaxProbe),
	)
	request := seckillBuyIntentRequest{
		SkuID:             item.SkuID,
		Quantity:          item.Quantity,
		SeckillStockLimit: cfg.stockLimit,
		BucketCount:       a.cfg.kafkaBucketCount,
		PrimaryBucketID:   primaryBucketID,
		BucketID:          primaryBucketID,
		Attempt:           0,
		MaxProbe:          a.cfg.kafkaMaxProbe,
		ProcessingKey:     buildProcessingKey(item.SkuID, primaryBucketID),
		Command: buyIntentCommand{
			CommandID:      commandID,
			CorrelationID:  correlationID,
			BuyerID:        body.BuyerID,
			Items:          toCheckoutItems(body.Items),
			IdempotencyKey: idempotencyKey,
			Metadata: eventMetadata{
				RequestID:     requestID,
				TraceID:       traceIDFromContext(ctx),
				Source:        "web",
				ActorID:       body.BuyerID,
				CommandID:     commandID,
				CorrelationID: correlationID,
				Traceparent:   traceCarrier["traceparent"],
				Tracestate:    traceCarrier["tracestate"],
				Baggage:       traceCarrier["baggage"],
			},
			IssuedAt: time.Now().UTC().Format(time.RFC3339Nano),
		},
	}
	buildSpan.End()

	encodeCtx, encodeSpan := a.tracer.Start(buildCtx, "buy_intent.encode_seckill_request")
	payload, err := json.Marshal(request)
	if err != nil {
		encodeSpan.RecordError(err)
		encodeSpan.SetStatus(codes.Error, "encode_failed")
		encodeSpan.End()
		span.RecordError(err)
		span.SetStatus(codes.Error, "encode_failed")
		writeError(w, requestID, traceIDFromContext(ctx), http.StatusInternalServerError, "Buy intent command could not be accepted. Please try again.")
		return
	}
	encodeSpan.SetAttributes(attribute.Int("messaging.message_payload_size_bytes", len(payload)))
	encodeSpan.End()

	publishCtx, publishSpan := a.tracer.Start(encodeCtx, "buy_intent.publish_seckill_go")
	publishSpan.SetAttributes(
		attribute.String("messaging.system", "kafka"),
		attribute.String("messaging.operation", "publish"),
		attribute.String("messaging.destination.name", a.cfg.kafkaRequestTopic),
		attribute.String("buy_intent.command_id", commandID),
		attribute.String("buy_intent.sku_id", item.SkuID),
		attribute.String("messaging.kafka.message_key", request.ProcessingKey),
		attribute.Int("messaging.message_payload_size_bytes", len(payload)),
		attribute.Int("messaging.kafka.batch_size", a.cfg.kafkaBatchSize),
		attribute.Int("messaging.kafka.batch_timeout_ms", a.cfg.kafkaLingerMs),
		attribute.Int("messaging.kafka.broker_count", len(a.cfg.kafkaBrokers)),
	)
	headers := make([]kafka.Header, 0, 3)
	for _, key := range []string{"traceparent", "tracestate", "baggage"} {
		if value := traceCarrier[key]; value != "" {
			headers = append(headers, kafka.Header{Key: key, Value: []byte(value)})
		}
	}
	writeCtx, writeSpan := a.tracer.Start(publishCtx, "kafka.write_messages")
	writeSpan.SetAttributes(
		attribute.String("messaging.destination.name", a.cfg.kafkaRequestTopic),
		attribute.String("messaging.kafka.message_key", request.ProcessingKey),
	)
	err = a.writer.WriteMessages(writeCtx, kafka.Message{
		Key:     []byte(request.ProcessingKey),
		Value:   payload,
		Time:    time.Now().UTC(),
		Headers: headers,
	})
	if err != nil {
		writeSpan.RecordError(err)
		writeSpan.SetStatus(codes.Error, "write_failed")
		writeSpan.End()
		publishSpan.RecordError(err)
		publishSpan.SetStatus(codes.Error, "publish_failed")
		publishSpan.End()
		span.RecordError(err)
		span.SetStatus(codes.Error, "publish_failed")
		writeError(w, requestID, traceIDFromContext(ctx), http.StatusInternalServerError, "Buy intent command could not be accepted. Please try again.")
		return
	}
	writeSpan.End()
	publishSpan.End()

	span.SetAttributes(
		attribute.String("buy_intent.command_id", commandID),
		attribute.String("buy_intent.correlation_id", correlationID),
		attribute.String("buy_intent.sku_id", item.SkuID),
		attribute.Int("buy_intent.primary_bucket_id", primaryBucketID),
		attribute.String("http.request_id", requestID),
	)

	writeJSON(w, http.StatusAccepted, traceIDFromContext(ctx), requestID, acceptResponse{
		CommandID:     commandID,
		CorrelationID: correlationID,
		Status:        "accepted",
	})
}

func validateRequest(body requestBody) error {
	if strings.TrimSpace(body.BuyerID) == "" {
		return errors.New("buyerId is required.")
	}
	if len(body.Items) == 0 {
		return errors.New("items must be a non-empty array.")
	}
	if len(body.Items) != 1 {
		return errUnsupportedCart
	}
	item := body.Items[0]
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
	return nil
}

func (a *app) readSeckillConfig(ctx context.Context, skuID string) (cachedSeckillConfig, error) {
	ctx, span := a.tracer.Start(ctx, "buy_intent.lookup_seckill_sku")
	defer span.End()
	span.SetAttributes(
		attribute.String("buy_intent.sku_id", skuID),
		attribute.Int64("cache.ttl_ms", a.cfg.cacheTTL.Milliseconds()),
	)

	now := time.Now().UnixMilli()
	a.cache.mu.RLock()
	cached, ok := a.cache.entries[skuID]
	a.cache.mu.RUnlock()
	if ok && cached.expiresAtMs > now {
		span.SetAttributes(
			attribute.Bool("cache.hit", true),
			attribute.Bool("buy_intent.seckill_enabled", cached.enabled),
			attribute.Int("buy_intent.seckill_stock_limit", cached.stockLimit),
		)
		return cached, nil
	}
	span.SetAttributes(attribute.Bool("cache.hit", false))

	row := a.db.QueryRowContext(ctx, `
      select seckill_enabled, seckill_stock_limit
      from sku
      where sku_id = $1
      limit 1
    `, skuID)

	var enabled bool
	var stockLimit sql.NullInt64
	if err := row.Scan(&enabled, &stockLimit); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			cfg := cachedSeckillConfig{enabled: false, stockLimit: 0, expiresAtMs: now + a.cfg.cacheTTL.Milliseconds()}
			a.cache.mu.Lock()
			a.cache.entries[skuID] = cfg
			a.cache.mu.Unlock()
			span.SetAttributes(
				attribute.Bool("buy_intent.seckill_enabled", false),
				attribute.Int("buy_intent.seckill_stock_limit", 0),
			)
			return cfg, nil
		}
		span.RecordError(err)
		span.SetStatus(codes.Error, "lookup_failed")
		return cachedSeckillConfig{}, err
	}

	cfg := cachedSeckillConfig{
		enabled:     enabled,
		stockLimit:  int(stockLimit.Int64),
		expiresAtMs: now + a.cfg.cacheTTL.Milliseconds(),
	}
	a.cache.mu.Lock()
	a.cache.entries[skuID] = cfg
	a.cache.mu.Unlock()
	span.SetAttributes(
		attribute.Bool("buy_intent.seckill_enabled", enabled),
		attribute.Int("buy_intent.seckill_stock_limit", cfg.stockLimit),
	)
	return cfg, nil
}

func setupTelemetry(cfg config) (func(context.Context) error, error) {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
	if !cfg.otelEnabled {
		return func(context.Context) error { return nil }, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(cfg.otlpEndpoint+"/v1/traces"))
	if err != nil {
		return nil, err
	}
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.serviceName),
		),
	)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(250*time.Millisecond)),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	return tp.Shutdown, nil
}

func traceIDFromContext(ctx context.Context) string {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		return sc.TraceID().String()
	}
	return uuid.NewString()
}

func injectTraceCarrier(ctx context.Context) map[string]string {
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	return map[string]string(carrier)
}

func writeJSON(w http.ResponseWriter, status int, traceID string, requestID string, body any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("x-request-id", requestID)
	w.Header().Set("x-trace-id", traceID)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, requestID string, traceID string, status int, message string) {
	writeJSON(w, status, traceID, requestID, errorResponse{
		Error:     message,
		RequestID: requestID,
	})
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
	h := fnv.New32a()
	_, _ = h.Write([]byte(stableKey))
	return int(h.Sum32() % uint32(bucketCount))
}

func buildProcessingKey(skuID string, bucketID int) string {
	return fmt.Sprintf("%s#%02d", skuID, bucketID)
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func envDefault(name string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
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
		log.Fatalf("%s must be an integer: %v", name, err)
	}
	return parsed
}

func mustParsePgxConfig(databaseURL string) *pgx.ConnConfig {
	cfg, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		log.Fatalf("parse DATABASE_URL: %v", err)
	}
	return cfg
}
