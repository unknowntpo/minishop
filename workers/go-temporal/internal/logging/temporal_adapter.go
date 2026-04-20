package logging

import (
	temporallog "go.temporal.io/sdk/log"
	"go.uber.org/zap"
)

type temporalAdapter struct {
	logger *zap.Logger
}

func NewTemporalAdapter(logger *zap.Logger) temporallog.Logger {
	return temporalAdapter{logger: logger}
}

func (l temporalAdapter) Debug(msg string, keyvals ...interface{}) {
	l.logger.Debug(msg, toFields(keyvals)...)
}

func (l temporalAdapter) Info(msg string, keyvals ...interface{}) {
	l.logger.Info(msg, toFields(keyvals)...)
}

func (l temporalAdapter) Warn(msg string, keyvals ...interface{}) {
	l.logger.Warn(msg, toFields(keyvals)...)
}

func (l temporalAdapter) Error(msg string, keyvals ...interface{}) {
	l.logger.Error(msg, toFields(keyvals)...)
}

func (l temporalAdapter) With(keyvals ...interface{}) temporallog.Logger {
	return temporalAdapter{logger: l.logger.With(toFields(keyvals)...)}
}

func (l temporalAdapter) WithCallerSkip(count int) temporallog.Logger {
	return temporalAdapter{logger: l.logger.WithOptions(zap.AddCallerSkip(count))}
}

func toFields(keyvals []interface{}) []zap.Field {
	fields := make([]zap.Field, 0, len(keyvals)/2+1)
	for i := 0; i < len(keyvals); i += 2 {
		key := "field"
		if rawKey, ok := keyvals[i].(string); ok && rawKey != "" {
			key = rawKey
		}

		if i+1 >= len(keyvals) {
			fields = append(fields, zap.Any(key, nil))
			continue
		}

		fields = append(fields, zap.Any(key, keyvals[i+1]))
	}
	return fields
}
