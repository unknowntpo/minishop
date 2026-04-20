package temporal

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"minishop/workers/go-temporal/internal/contracts"
)

func BuyIntentCommandWorkflow(ctx workflow.Context, input contracts.WorkflowInput) (contracts.WorkflowResult, error) {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumAttempts:    5,
		},
	})

	logger := workflow.GetLogger(ctx)
	logger.Info("buy_intent_workflow_started", "command_id", input.CommandID)

	processingCh := workflow.GetSignalChannel(ctx, contracts.SignalProcessing)
	createdCh := workflow.GetSignalChannel(ctx, contracts.SignalCreated)
	failedCh := workflow.GetSignalChannel(ctx, contracts.SignalFailed)

	state := "accepted"
	var result contracts.WorkflowResult
	var completionErr error
	done := false

	for !done {
		selector := workflow.NewSelector(ctx)

		selector.AddReceive(processingCh, func(c workflow.ReceiveChannel, more bool) {
			var commandID string
			c.Receive(ctx, &commandID)
			if state == "accepted" {
				state = "processing"
			}
		})

		selector.AddReceive(createdCh, func(c workflow.ReceiveChannel, more bool) {
			var payload contracts.CreatedSignalPayload
			c.Receive(ctx, &payload)
			completionErr = workflow.ExecuteActivity(ctx, "complete-demo-checkout", CompleteCheckoutInput{
				CommandID:        input.CommandID,
				CorrelationID:    input.CorrelationID,
				CheckoutIntentID: payload.CheckoutIntentID,
			}).Get(ctx, nil)
			result = contracts.WorkflowResult{
				CommandID:        input.CommandID,
				Status:           "created",
				CheckoutIntentID: payload.CheckoutIntentID,
				EventID:          payload.EventID,
				IsDuplicate:      payload.IsDuplicate,
			}
			done = true
		})

		selector.AddReceive(failedCh, func(c workflow.ReceiveChannel, more bool) {
			var payload contracts.FailedSignalPayload
			c.Receive(ctx, &payload)
			result = contracts.WorkflowResult{
				CommandID:      input.CommandID,
				Status:         "failed",
				FailureCode:    payload.FailureCode,
				FailureMessage: payload.FailureMessage,
			}
			done = true
		})

		selector.Select(ctx)
	}

	if completionErr != nil {
		logger.Error("buy_intent_workflow_completion_failed", "command_id", input.CommandID, "error", completionErr)
		return result, completionErr
	}

	logger.Info("buy_intent_workflow_completed", "command_id", input.CommandID, "status", result.Status)
	return result, nil
}
