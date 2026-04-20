package merge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	sdkclient "go.temporal.io/sdk/client"
	"go.uber.org/zap"

	"minishop/workers/go-temporal/internal/contracts"
	"minishop/workers/go-temporal/internal/store/sqlcdb"
)

type Service struct {
	pool         *pgxpool.Pool
	queries      *sqlcdb.Queries
	temporal     sdkclient.Client
	logger       *zap.Logger
	taskQueue    string
	batchSize    int32
	pollInterval time.Duration
}

type appendResult struct {
	CheckoutIntentID string
	EventID          string
	IsDuplicate      bool
}

func NewService(
	pool *pgxpool.Pool,
	temporal sdkclient.Client,
	logger *zap.Logger,
	taskQueue string,
	batchSize int32,
	pollInterval time.Duration,
) *Service {
	return &Service{
		pool:         pool,
		queries:      sqlcdb.New(pool),
		temporal:     temporal,
		logger:       logger,
		taskQueue:    taskQueue,
		batchSize:    batchSize,
		pollInterval: pollInterval,
	}
}

func (s *Service) Run(ctx context.Context) error {
	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()

	for {
		if err := s.processOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			s.logger.Error("buy_intent_merge_iteration_failed", zap.Error(err))
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Service) processOnce(ctx context.Context) error {
	rows, err := s.queries.ClaimPendingBatch(ctx, sqlcdb.ClaimPendingBatchParams{
		BatchID: pgtype.UUID{Bytes: uuid.New(), Valid: true},
		Limit:   s.batchSize,
	})
	if err != nil {
		return err
	}

	for _, row := range rows {
		if err := s.processRow(ctx, row); err != nil {
			s.logger.Error(
				"buy_intent_merge_row_failed",
				zap.String("command_id", row.CommandID.String()),
				zap.Int64("staging_id", row.StagingID),
				zap.Error(err),
			)
		}
	}

	return nil
}

func (s *Service) processRow(ctx context.Context, row sqlcdb.ClaimPendingBatchRow) error {
	command, err := decodeCommand(row.PayloadJson)
	if err != nil {
		return s.failClaimedCommand(
			ctx,
			row,
			fallbackCommandFromRow(row),
			contracts.FailureCodeMergeFailed,
			fmt.Sprintf("Invalid staged payload: %v", err),
		)
	}

	status, err := s.queries.GetCommandStatus(ctx, row.CommandID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return s.failClaimedCommand(
				ctx,
				row,
				command,
				contracts.FailureCodeMissingCommandStatus,
				"Command status row was not found for claimed staging entry.",
			)
		}
		return err
	}

	switch status.Status {
	case "created", "failed":
		return s.markMergedDuplicateCommand(ctx, row.StagingID, row.CommandID)
	}

	if err := s.queries.MarkCommandProcessing(ctx, row.CommandID); err != nil {
		return err
	}
	s.signalProcessing(ctx, command)

	result, err := s.appendCheckoutIntentCreated(ctx, command)
	if err != nil {
		return s.failClaimedCommand(ctx, row, command, contracts.FailureCodeMergeFailed, err.Error())
	}

	if err := s.markCreated(ctx, row.StagingID, row.CommandID, result); err != nil {
		return err
	}
	s.signalCreated(ctx, command, result)
	return nil
}

func (s *Service) appendCheckoutIntentCreated(ctx context.Context, command contracts.BuyIntentCommand) (appendResult, error) {
	if err := validateCommand(command); err != nil {
		return appendResult{}, err
	}

	checkoutIntentID := uuid.NewString()
	eventID := uuid.NewString()
	occurredAt, err := time.Parse(time.RFC3339, command.IssuedAt)
	if err != nil {
		occurredAt = time.Now().UTC()
	}

	payload, err := json.Marshal(contracts.CheckoutIntentCreatedPayload{
		CheckoutIntentID: checkoutIntentID,
		BuyerID:          command.BuyerID,
		Items:            command.Items,
		IdempotencyKey:   command.IdempotencyKey,
	})
	if err != nil {
		return appendResult{}, err
	}

	metadata, err := json.Marshal(command.Metadata)
	if err != nil {
		return appendResult{}, err
	}

	inserted, err := s.queries.InsertCheckoutIntentCreatedEvent(ctx, sqlcdb.InsertCheckoutIntentCreatedEventParams{
		EventID:        pgtype.UUID{Bytes: uuid.MustParse(eventID), Valid: true},
		AggregateID:    checkoutIntentID,
		Column3:        payload,
		Column4:        metadata,
		IdempotencyKey: nullableText(command.IdempotencyKey),
		OccurredAt:     pgtype.Timestamptz{Time: occurredAt, Valid: true},
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return appendResult{}, err
	}

	if inserted.EventID.Valid {
		return appendResult{
			CheckoutIntentID: checkoutIntentID,
			EventID:          uuid.UUID(inserted.EventID.Bytes).String(),
			IsDuplicate:      false,
		}, nil
	}

	if command.IdempotencyKey == "" {
		return appendResult{}, fmt.Errorf("event append failed without an idempotency replay path")
	}

	existing, err := s.queries.GetEventByIdempotencyKey(ctx, nullableText(command.IdempotencyKey))
	if err != nil {
		return appendResult{}, err
	}
	if existing.EventType != "CheckoutIntentCreated" {
		return appendResult{}, fmt.Errorf("idempotency key resolved to a non-checkout event")
	}

	var existingPayload contracts.CheckoutIntentCreatedPayload
	if err := json.Unmarshal(existing.Payload, &existingPayload); err != nil {
		return appendResult{}, err
	}

	return appendResult{
		CheckoutIntentID: existingPayload.CheckoutIntentID,
		EventID:          uuid.UUID(existing.EventID.Bytes).String(),
		IsDuplicate:      true,
	}, nil
}

func (s *Service) markCreated(
	ctx context.Context,
	stagingID int64,
	commandID pgtype.UUID,
	result appendResult,
) error {
	return withTx(ctx, s.pool, func(q *sqlcdb.Queries) error {
		if err := q.MarkCommandCreated(ctx, sqlcdb.MarkCommandCreatedParams{
			CommandID:        commandID,
			CheckoutIntentID: pgtype.UUID{Bytes: uuid.MustParse(result.CheckoutIntentID), Valid: true},
			EventID:          pgtype.UUID{Bytes: uuid.MustParse(result.EventID), Valid: true},
			IsDuplicate:      result.IsDuplicate,
		}); err != nil {
			return err
		}

		return q.MarkStagingMerged(ctx, stagingID)
	})
}

func (s *Service) failClaimedCommand(
	ctx context.Context,
	row sqlcdb.ClaimPendingBatchRow,
	command contracts.BuyIntentCommand,
	failureCode string,
	failureMessage string,
) error {
	if err := withTx(ctx, s.pool, func(q *sqlcdb.Queries) error {
		if err := q.MarkCommandFailed(ctx, sqlcdb.MarkCommandFailedParams{
			CommandID:      row.CommandID,
			FailureCode:    nullableText(failureCode),
			FailureMessage: nullableText(failureMessage),
		}); err != nil {
			return err
		}

		return q.MarkStagingFailed(ctx, sqlcdb.MarkStagingFailedParams{
			StagingID:     row.StagingID,
			IngestStatus:  "dlq",
			LastErrorCode: nullableText(failureCode),
		})
	}); err != nil {
		return err
	}

	s.signalFailed(ctx, command, failureCode, failureMessage)
	return nil
}

func (s *Service) markMergedDuplicateCommand(ctx context.Context, stagingID int64, commandID pgtype.UUID) error {
	return withTx(ctx, s.pool, func(q *sqlcdb.Queries) error {
		if err := q.MarkStagingMerged(ctx, stagingID); err != nil {
			return err
		}
		return q.TouchCommandStatus(ctx, commandID)
	})
}

func (s *Service) signalProcessing(ctx context.Context, command contracts.BuyIntentCommand) {
	if err := s.signalWithStart(ctx, command, contracts.SignalProcessing, command.CommandID); err != nil {
		s.logger.Warn("buy_intent_signal_processing_failed", zap.String("command_id", command.CommandID), zap.Error(err))
	}
}

func (s *Service) signalCreated(ctx context.Context, command contracts.BuyIntentCommand, result appendResult) {
	if err := s.signalWithStart(ctx, command, contracts.SignalCreated, contracts.CreatedSignalPayload{
		CheckoutIntentID: result.CheckoutIntentID,
		EventID:          result.EventID,
		IsDuplicate:      result.IsDuplicate,
	}); err != nil {
		s.logger.Warn("buy_intent_signal_created_failed", zap.String("command_id", command.CommandID), zap.Error(err))
	}
}

func (s *Service) signalFailed(ctx context.Context, command contracts.BuyIntentCommand, failureCode string, failureMessage string) {
	if err := s.signalWithStart(ctx, command, contracts.SignalFailed, contracts.FailedSignalPayload{
		FailureCode:    failureCode,
		FailureMessage: failureMessage,
	}); err != nil {
		s.logger.Warn("buy_intent_signal_failed", zap.String("command_id", command.CommandID), zap.Error(err))
	}
}

func (s *Service) signalWithStart(
	ctx context.Context,
	command contracts.BuyIntentCommand,
	signalName string,
	signalArg any,
) error {
	_, err := s.temporal.SignalWithStartWorkflow(
		ctx,
		contracts.WorkflowID(command.CommandID),
		signalName,
		signalArg,
		sdkclient.StartWorkflowOptions{
			ID:        contracts.WorkflowID(command.CommandID),
			TaskQueue: s.taskQueue,
		},
		contracts.WorkflowName,
		contracts.WorkflowInput{
			CommandID:     command.CommandID,
			CorrelationID: command.CorrelationID,
			IssuedAt:      issuedAtOrNow(command.IssuedAt),
		},
	)
	return err
}

func withTx(ctx context.Context, pool *pgxpool.Pool, fn func(*sqlcdb.Queries) error) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}

	defer func() {
		_ = tx.Rollback(ctx)
	}()

	if err := fn(sqlcdb.New(tx)); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

func decodeCommand(payload []byte) (contracts.BuyIntentCommand, error) {
	if err := contracts.ValidateBuyIntentCommandDocument(payload); err != nil {
		return contracts.BuyIntentCommand{}, err
	}

	var command contracts.BuyIntentCommand
	if err := json.Unmarshal(payload, &command); err != nil {
		return contracts.BuyIntentCommand{}, err
	}
	return command, nil
}

func validateCommand(command contracts.BuyIntentCommand) error {
	if command.CommandID == "" {
		return fmt.Errorf("command_id is required")
	}
	if command.CorrelationID == "" {
		return fmt.Errorf("correlation_id is required")
	}
	if command.BuyerID == "" {
		return fmt.Errorf("buyer_id is required")
	}
	if len(command.Items) == 0 {
		return fmt.Errorf("items must be non-empty")
	}
	return nil
}

func nullableText(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func issuedAtOrNow(value string) string {
	if _, err := time.Parse(time.RFC3339, value); err == nil {
		return value
	}
	return time.Now().UTC().Format(time.RFC3339)
}

func fallbackCommandFromRow(row sqlcdb.ClaimPendingBatchRow) contracts.BuyIntentCommand {
	return contracts.BuyIntentCommand{
		CommandID:     row.CommandID.String(),
		CorrelationID: row.CorrelationID.String(),
		IssuedAt:      time.Now().UTC().Format(time.RFC3339),
	}
}
