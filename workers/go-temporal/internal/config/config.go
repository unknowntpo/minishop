package config

import (
	"fmt"
	"time"

	"github.com/spf13/viper"

	"minishop/workers/go-temporal/internal/contracts"
)

type Config struct {
	DatabaseURL      string
	TemporalAddress  string
	TemporalNamespace string
	TaskQueue        string
	MergeBatchSize   int32
	MergePollInterval time.Duration
	LogLevel         string
}

func Load() (Config, error) {
	viper.AutomaticEnv()
	viper.SetDefault("TEMPORAL_NAMESPACE", "default")
	viper.SetDefault("TEMPORAL_BUY_INTENT_TASK_QUEUE", contracts.TaskQueue)
	viper.SetDefault("BUY_INTENT_BATCH_SIZE", 100)
	viper.SetDefault("BUY_INTENT_PROCESS_POLL_INTERVAL_MS", 1000)
	viper.SetDefault("LOG_LEVEL", "info")

	cfg := Config{
		DatabaseURL:       viper.GetString("DATABASE_URL"),
		TemporalAddress:   viper.GetString("TEMPORAL_ADDRESS"),
		TemporalNamespace: viper.GetString("TEMPORAL_NAMESPACE"),
		TaskQueue:         viper.GetString("TEMPORAL_BUY_INTENT_TASK_QUEUE"),
		MergeBatchSize:    int32(viper.GetInt("BUY_INTENT_BATCH_SIZE")),
		MergePollInterval: time.Duration(viper.GetInt("BUY_INTENT_PROCESS_POLL_INTERVAL_MS")) * time.Millisecond,
		LogLevel:          viper.GetString("LOG_LEVEL"),
	}

	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.TemporalAddress == "" {
		return Config{}, fmt.Errorf("TEMPORAL_ADDRESS is required")
	}
	if cfg.TaskQueue == "" {
		return Config{}, fmt.Errorf("TEMPORAL_BUY_INTENT_TASK_QUEUE is required")
	}
	if cfg.MergeBatchSize < 1 {
		cfg.MergeBatchSize = 1
	}
	if cfg.MergePollInterval <= 0 {
		cfg.MergePollInterval = time.Second
	}

	return cfg, nil
}
