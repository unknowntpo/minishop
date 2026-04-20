package main

import (
	"context"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	sdkactivity "go.temporal.io/sdk/activity"
	sdkclient "go.temporal.io/sdk/client"
	sdkworker "go.temporal.io/sdk/worker"
	sdkworkflow "go.temporal.io/sdk/workflow"
	"go.uber.org/zap"

	"minishop/workers/go-temporal/internal/config"
	"minishop/workers/go-temporal/internal/logging"
	"minishop/workers/go-temporal/internal/merge"
	workerworkflow "minishop/workers/go-temporal/internal/temporal"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		panic(err)
	}

	logger, err := logging.New(cfg.LogLevel)
	if err != nil {
		panic(err)
	}
	defer func() { _ = logger.Sync() }()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Fatal("postgres_connect_failed", zap.Error(err))
	}
	defer pool.Close()

	temporalClient, err := sdkclient.Dial(sdkclient.Options{
		HostPort:  cfg.TemporalAddress,
		Namespace: cfg.TemporalNamespace,
		Logger:    logging.NewTemporalAdapter(logger),
	})
	if err != nil {
		logger.Fatal("temporal_connect_failed", zap.Error(err))
	}
	defer temporalClient.Close()

	tw := sdkworker.New(temporalClient, cfg.TaskQueue, sdkworker.Options{})
	tw.RegisterWorkflowWithOptions(workerworkflow.BuyIntentCommandWorkflow, sdkworkflow.RegisterOptions{
		Name: "buy-intent-command-workflow",
	})
	tw.RegisterActivityWithOptions(
		workerworkflow.NewCheckoutCompletionActivities(pool, logger).CompleteCheckout,
		sdkactivity.RegisterOptions{Name: "complete-demo-checkout"},
	)

	if err := tw.Start(); err != nil {
		logger.Fatal("temporal_worker_start_failed", zap.Error(err))
	}
	defer tw.Stop()

	service := merge.NewService(
		pool,
		temporalClient,
		logger,
		cfg.TaskQueue,
		cfg.MergeBatchSize,
		cfg.MergePollInterval,
	)

	logger.Info(
		"buy_intent_go_worker_started",
		zap.String("task_queue", cfg.TaskQueue),
		zap.Int32("merge_batch_size", cfg.MergeBatchSize),
		zap.Duration("merge_poll_interval", cfg.MergePollInterval),
	)

	if err := service.Run(ctx); err != nil && ctx.Err() == nil {
		logger.Fatal("buy_intent_go_worker_failed", zap.Error(err))
	}
}
