package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"
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
	databaseURL                 string
	databasePoolMax             int
	kafkaBrokers                []string
	kafkaResultTopic            string
	kafkaGroupID                string
	kafkaClientID               string
	kafkaPartitionsConcurrently int
	kafkaMinBytes               int
	kafkaMaxBytes               int
	kafkaMaxWait                time.Duration
	kafkaCommitInterval         time.Duration
	serviceName                 string
	otlpEndpoint                string
	otelEnabled                 bool
}

type seckillCommandOutcome struct {
	Request     seckillCommandOutcomeRequest `json:"request"`
	Result      seckillCommandResult         `json:"result"`
	ProcessedAt string                       `json:"processedAt"`
}

type seckillCommandOutcomeRequest struct {
	CommandID      string         `json:"commandId"`
	CorrelationID  string         `json:"correlationId"`
	BuyerID        string         `json:"buyerId"`
	Items          []checkoutItem `json:"items"`
	IdempotencyKey string         `json:"idempotencyKey,omitempty"`
	Metadata       eventMetadata  `json:"metadata"`
}

type seckillCommandResult struct {
	CommandID         string `json:"commandId"`
	CorrelationID     string `json:"correlationId"`
	SkuID             string `json:"skuId"`
	CheckoutIntentID  string `json:"checkoutIntentId"`
	Status            string `json:"status"`
	RequestedQuantity int    `json:"requestedQuantity"`
	SeckillStockLimit int    `json:"seckillStockLimit"`
	FailureReason     string `json:"failureReason"`
	EventID           string `json:"eventId"`
	Duplicate         bool   `json:"duplicate"`
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

type app struct {
	cfg    config
	db     *pgxpool.Pool
	reader *kafka.Reader
	tracer trace.Tracer
}

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

	dbCfg, err := pgxpool.ParseConfig(cfg.databaseURL)
	if err != nil {
		log.Fatalf("parse DATABASE_URL: %v", err)
	}
	dbCfg.MaxConns = int32(cfg.databasePoolMax)
	dbCfg.MinConns = 1
	dbCfg.MaxConnLifetime = 5 * time.Minute
	db, err := pgxpool.NewWithConfig(context.Background(), dbCfg)
	if err != nil {
		log.Fatalf("create pool: %v", err)
	}

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:                cfg.kafkaBrokers,
		GroupID:                cfg.kafkaGroupID,
		Topic:                  cfg.kafkaResultTopic,
		MinBytes:               cfg.kafkaMinBytes,
		MaxBytes:               cfg.kafkaMaxBytes,
		MaxWait:                cfg.kafkaMaxWait,
		StartOffset:            kafka.LastOffset,
		ReadLagInterval:        -1,
		CommitInterval:         cfg.kafkaCommitInterval,
		WatchPartitionChanges:  true,
		PartitionWatchInterval: 5 * time.Second,
		Dialer: &kafka.Dialer{
			ClientID: cfg.kafkaClientID,
			Timeout:  5 * time.Second,
		},
	})

	instance := &app{
		cfg:    cfg,
		db:     db,
		reader: reader,
		tracer: otel.Tracer("go-seckill-result-sink"),
	}

	if err := instance.warmUp(context.Background()); err != nil {
		log.Fatalf("warm up go-seckill-result-sink: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := instance.run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("run go-seckill-result-sink: %v", err)
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = reader.Close()
	db.Close()
	_ = flush(shutdownCtx)
}

func readConfig() config {
	return config{
		databaseURL:                 requiredEnv("DATABASE_URL"),
		databasePoolMax:             envInt("DATABASE_POOL_MAX", 8),
		kafkaBrokers:                splitCSV(envDefault("KAFKA_BROKERS", "redpanda:9092")),
		kafkaResultTopic:            envDefault("KAFKA_SECKILL_RESULT_TOPIC", "inventory.seckill.result"),
		kafkaGroupID:                envDefault("KAFKA_SECKILL_RESULT_SINK_GROUP_ID", "minishop-seckill-result-sink"),
		kafkaClientID:               envDefault("KAFKA_SECKILL_RESULT_SINK_CLIENT_ID", "minishop-go-seckill-result-sink"),
		kafkaPartitionsConcurrently: envInt("KAFKA_SECKILL_RESULT_SINK_PARTITIONS_CONCURRENTLY", 6),
		kafkaMinBytes:               envInt("GO_SECKILL_RESULT_SINK_MIN_BYTES", 1),
		kafkaMaxBytes:               envInt("GO_SECKILL_RESULT_SINK_MAX_BYTES", 10_000_000),
		kafkaMaxWait:                time.Duration(envInt("GO_SECKILL_RESULT_SINK_MAX_WAIT_MS", 250)) * time.Millisecond,
		kafkaCommitInterval:         time.Duration(envInt("GO_SECKILL_RESULT_SINK_COMMIT_INTERVAL_MS", 0)) * time.Millisecond,
		serviceName:                 envDefault("OTEL_SERVICE_NAME", "go-seckill-result-sink"),
		otlpEndpoint:                envDefault("OTEL_EXPORTER_OTLP_ENDPOINT", "http://tempo:4318"),
		otelEnabled:                 envDefault("OTEL_ENABLED", "1") != "0",
	}
}

func (a *app) warmUp(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := a.db.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("db acquire: %w", err)
	}
	conn.Release()

	dialer := &kafka.Dialer{ClientID: a.cfg.kafkaClientID, Timeout: 5 * time.Second}
	connKafka, err := dialer.DialContext(ctx, "tcp", a.cfg.kafkaBrokers[0])
	if err != nil {
		return fmt.Errorf("kafka dial: %w", err)
	}
	return connKafka.Close()
}

func (a *app) run(ctx context.Context) error {
	workers := a.cfg.kafkaPartitionsConcurrently
	if workers < 1 {
		workers = 1
	}

	errCh := make(chan error, workers)
	for i := 0; i < workers; i++ {
		go func() {
			for {
				message, err := a.reader.FetchMessage(ctx)
				if err != nil {
					if errors.Is(err, context.Canceled) {
						errCh <- ctx.Err()
						return
					}
					errCh <- err
					return
				}
				if err := a.handleMessage(ctx, message); err != nil {
					errCh <- err
					return
				}
				if err := a.reader.CommitMessages(ctx, message); err != nil {
					errCh <- err
					return
				}
			}
		}()
	}

	for range workers {
		if err := <-errCh; err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
	}
	return nil
}

func (a *app) handleMessage(ctx context.Context, message kafka.Message) error {
	if len(message.Value) == 0 {
		return nil
	}

	value := bytes.TrimLeft(message.Value, "\x00\r\n\t ")
	if len(value) == 0 {
		log.Printf("skip empty seckill result payload partition=%d offset=%d", message.Partition, message.Offset)
		return nil
	}
	if value[0] != '{' && value[0] != '[' {
		log.Printf("skip non-json seckill result payload partition=%d offset=%d first_byte=%q", message.Partition, message.Offset, value[0])
		return nil
	}

	var outcome seckillCommandOutcome
	if err := json.Unmarshal(value, &outcome); err != nil {
		log.Printf("skip undecodable seckill result payload partition=%d offset=%d err=%v", message.Partition, message.Offset, err)
		return nil
	}

	parentContext := extractParentContext(message.Headers)
	spanCtx, span := a.tracer.Start(parentContext, "inventory.seckill.result.persist",
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination.name", a.cfg.kafkaResultTopic),
			attribute.String("buy_intent.command_id", outcome.Result.CommandID),
			attribute.String("buy_intent.correlation_id", outcome.Result.CorrelationID),
			attribute.String("buy_intent.sku_id", outcome.Result.SkuID),
			attribute.String("seckill.result.status", outcome.Result.Status),
		),
	)
	defer span.End()

	txCtx, txSpan := a.tracer.Start(spanCtx, "db.tx.persist_seckill_result")
	tx, err := a.db.Begin(txCtx)
	if err != nil {
		txSpan.RecordError(err)
		txSpan.SetStatus(codes.Error, "db_begin_failed")
		txSpan.End()
		return fmt.Errorf("begin tx: %w", err)
	}

	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()

	if outcome.Result.Status == "reserved" {
		if err := a.insertEventStore(txCtx, tx, outcome); err != nil {
			txSpan.RecordError(err)
			txSpan.SetStatus(codes.Error, "event_store_failed")
			txSpan.End()
			return err
		}
		if err := a.upsertCommandStatusCreated(txCtx, tx, outcome); err != nil {
			txSpan.RecordError(err)
			txSpan.SetStatus(codes.Error, "command_status_failed")
			txSpan.End()
			return err
		}
	} else {
		if err := a.upsertCommandStatusFailed(txCtx, tx, outcome); err != nil {
			txSpan.RecordError(err)
			txSpan.SetStatus(codes.Error, "command_status_failed")
			txSpan.End()
			return err
		}
	}

	if err := a.upsertSeckillCommandResult(txCtx, tx, outcome); err != nil {
		txSpan.RecordError(err)
		txSpan.SetStatus(codes.Error, "seckill_command_result_failed")
		txSpan.End()
		return err
	}

	commitCtx, commitSpan := a.tracer.Start(txCtx, "db.tx.commit")
	if err := tx.Commit(commitCtx); err != nil {
		commitSpan.RecordError(err)
		commitSpan.SetStatus(codes.Error, "db_commit_failed")
		commitSpan.End()
		txSpan.RecordError(err)
		txSpan.SetStatus(codes.Error, "db_commit_failed")
		txSpan.End()
		return fmt.Errorf("commit tx: %w", err)
	}
	commitSpan.End()
	committed = true
	txSpan.End()
	return nil
}

func (a *app) insertEventStore(ctx context.Context, tx pgx.Tx, outcome seckillCommandOutcome) error {
	_, span := a.tracer.Start(ctx, "db.event_store.insert")
	defer span.End()

	payload := map[string]any{
		"checkout_intent_id": outcome.Result.CheckoutIntentID,
		"buyer_id":           outcome.Request.BuyerID,
		"items":              outcome.Request.Items,
	}
	if outcome.Request.IdempotencyKey != "" {
		payload["idempotency_key"] = outcome.Request.IdempotencyKey
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "payload_encode_failed")
		return fmt.Errorf("marshal event payload: %w", err)
	}

	metadataJSON, err := json.Marshal(outcome.Request.Metadata)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "metadata_encode_failed")
		return fmt.Errorf("marshal metadata: %w", err)
	}

	_, err = tx.Exec(ctx, `
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
      values ($1, 'CheckoutIntentCreated', 1, 'checkout', $2, 1, $3::jsonb, $4::jsonb, $5, $6)
      on conflict (idempotency_key)
        where idempotency_key is not null
        do nothing
    `,
		outcome.Result.EventID,
		outcome.Result.CheckoutIntentID,
		string(payloadJSON),
		string(metadataJSON),
		nullable(outcome.Request.IdempotencyKey),
		outcome.ProcessedAt,
	)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "event_store_insert_failed")
		return fmt.Errorf("insert event_store: %w", err)
	}
	return nil
}

func (a *app) upsertCommandStatusCreated(ctx context.Context, tx pgx.Tx, outcome seckillCommandOutcome) error {
	_, span := a.tracer.Start(ctx, "db.command_status.upsert_created")
	defer span.End()

	_, err := tx.Exec(ctx, `
      insert into command_status (
        command_id,
        correlation_id,
        idempotency_key,
        status,
        checkout_intent_id,
        event_id,
        is_duplicate,
        failure_code,
        failure_message
      )
      values ($1, $2, $3, 'created', $4, $5, $6, null, null)
      on conflict (command_id)
      do update set
        correlation_id = excluded.correlation_id,
        idempotency_key = excluded.idempotency_key,
        status = excluded.status,
        checkout_intent_id = excluded.checkout_intent_id,
        event_id = excluded.event_id,
        is_duplicate = excluded.is_duplicate,
        failure_code = null,
        failure_message = null,
        updated_at = now()
    `,
		outcome.Result.CommandID,
		outcome.Result.CorrelationID,
		nullable(outcome.Request.IdempotencyKey),
		nullable(outcome.Result.CheckoutIntentID),
		nullable(outcome.Result.EventID),
		outcome.Result.Duplicate,
	)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "command_status_upsert_failed")
		return fmt.Errorf("upsert command_status(created): %w", err)
	}
	return nil
}

func (a *app) upsertCommandStatusFailed(ctx context.Context, tx pgx.Tx, outcome seckillCommandOutcome) error {
	_, span := a.tracer.Start(ctx, "db.command_status.upsert_failed")
	defer span.End()

	failureMessage := outcome.Result.FailureReason
	if failureMessage == "" {
		failureMessage = "seckill_out_of_stock"
	}
	_, err := tx.Exec(ctx, `
      insert into command_status (
        command_id,
        correlation_id,
        idempotency_key,
        status,
        is_duplicate,
        failure_code,
        failure_message
      )
      values ($1, $2, $3, 'failed', $4, 'seckill_out_of_stock', $5)
      on conflict (command_id)
      do update set
        correlation_id = excluded.correlation_id,
        idempotency_key = excluded.idempotency_key,
        status = excluded.status,
        is_duplicate = excluded.is_duplicate,
        failure_code = excluded.failure_code,
        failure_message = excluded.failure_message,
        updated_at = now()
    `,
		outcome.Result.CommandID,
		outcome.Result.CorrelationID,
		nullable(outcome.Request.IdempotencyKey),
		outcome.Result.Duplicate,
		failureMessage,
	)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "command_status_upsert_failed")
		return fmt.Errorf("upsert command_status(failed): %w", err)
	}
	return nil
}

func (a *app) upsertSeckillCommandResult(ctx context.Context, tx pgx.Tx, outcome seckillCommandOutcome) error {
	_, span := a.tracer.Start(ctx, "db.seckill_command_result.upsert")
	defer span.End()

	_, err := tx.Exec(ctx, `
      insert into seckill_command_result (
        command_id,
        correlation_id,
        sku_id,
        checkout_intent_id,
        status,
        requested_quantity,
        seckill_stock_limit,
        failure_reason
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (command_id)
      do update set
        correlation_id = excluded.correlation_id,
        sku_id = excluded.sku_id,
        checkout_intent_id = excluded.checkout_intent_id,
        status = excluded.status,
        requested_quantity = excluded.requested_quantity,
        seckill_stock_limit = excluded.seckill_stock_limit,
        failure_reason = excluded.failure_reason,
        updated_at = now()
    `,
		outcome.Result.CommandID,
		outcome.Result.CorrelationID,
		outcome.Result.SkuID,
		nullable(outcome.Result.CheckoutIntentID),
		outcome.Result.Status,
		outcome.Result.RequestedQuantity,
		outcome.Result.SeckillStockLimit,
		nullable(outcome.Result.FailureReason),
	)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "seckill_command_result_upsert_failed")
		return fmt.Errorf("upsert seckill_command_result: %w", err)
	}
	return nil
}

func extractParentContext(headers []kafka.Header) context.Context {
	carrier := propagation.MapCarrier{}
	for _, header := range headers {
		switch strings.ToLower(header.Key) {
		case "traceparent", "tracestate", "baggage":
			carrier[header.Key] = string(header.Value)
		}
	}
	if len(carrier) == 0 {
		return context.Background()
	}
	return otel.GetTextMapPropagator().Extract(context.Background(), carrier)
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

func nullable(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
