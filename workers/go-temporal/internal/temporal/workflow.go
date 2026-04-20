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
	paymentSucceededCh := workflow.GetSignalChannel(ctx, contracts.SignalPaymentSucceeded)
	paymentFailedCh := workflow.GetSignalChannel(ctx, contracts.SignalPaymentFailed)

	state := "accepted"
	var result contracts.WorkflowResult
	var paymentID string
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
			var startResult StartCheckoutResult
			err := workflow.ExecuteActivity(ctx, "start-demo-checkout", StartCheckoutInput{
				CommandID:        input.CommandID,
				CorrelationID:    input.CorrelationID,
				CheckoutIntentID: payload.CheckoutIntentID,
			}).Get(ctx, &startResult)
			result = contracts.WorkflowResult{
				CommandID:        input.CommandID,
				Status:           "created",
				CheckoutIntentID: payload.CheckoutIntentID,
				EventID:          payload.EventID,
				IsDuplicate:      payload.IsDuplicate,
			}
			if err != nil {
				result.CheckoutStatus = "failed"
				done = true
				return
			}

			result.PaymentID = startResult.PaymentID
			result.CheckoutStatus = startResult.CheckoutStatus

			switch startResult.CheckoutStatus {
			case "pending_payment":
				paymentID = startResult.PaymentID
				state = "pending_payment"
			case "rejected":
				done = true
			default:
				done = true
			}
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

		selector.AddReceive(paymentSucceededCh, func(c workflow.ReceiveChannel, more bool) {
			if state != "pending_payment" {
				var ignored contracts.PaymentSucceededSignalPayload
				c.Receive(ctx, &ignored)
				return
			}

			var payload contracts.PaymentSucceededSignalPayload
			c.Receive(ctx, &payload)
			var completionResult CompletePaymentResult
			err := workflow.ExecuteActivity(ctx, "complete-payment", CompletePaymentInput{
				CommandID:         input.CommandID,
				CheckoutIntentID:  result.CheckoutIntentID,
				PaymentID:         paymentID,
				ProviderReference: payload.ProviderReference,
			}).Get(ctx, &completionResult)
			if err != nil {
				result.CheckoutStatus = "failed"
				done = true
				return
			}
			result.CheckoutStatus = completionResult.CheckoutStatus
			result.OrderID = completionResult.OrderID
			result.PaymentID = completionResult.PaymentID
			done = true
		})

		selector.AddReceive(paymentFailedCh, func(c workflow.ReceiveChannel, more bool) {
			if state != "pending_payment" {
				var ignored contracts.PaymentFailedSignalPayload
				c.Receive(ctx, &ignored)
				return
			}

			var payload contracts.PaymentFailedSignalPayload
			c.Receive(ctx, &payload)
			var failureResult FailPaymentResult
			err := workflow.ExecuteActivity(ctx, "fail-payment", FailPaymentInput{
				CommandID:        input.CommandID,
				CheckoutIntentID: result.CheckoutIntentID,
				PaymentID:        paymentID,
				Reason:           payload.Reason,
			}).Get(ctx, &failureResult)
			if err != nil {
				result.CheckoutStatus = "failed"
				done = true
				return
			}
			result.CheckoutStatus = failureResult.CheckoutStatus
			done = true
		})

		if state == "pending_payment" {
			timeoutFuture := workflow.NewTimer(ctx, 30*time.Minute)
			selector.AddFuture(timeoutFuture, func(f workflow.Future) {
				var failureResult FailPaymentResult
				err := workflow.ExecuteActivity(ctx, "fail-payment", FailPaymentInput{
					CommandID:        input.CommandID,
					CheckoutIntentID: result.CheckoutIntentID,
					PaymentID:        paymentID,
					Reason:           "payment_timeout",
				}).Get(ctx, &failureResult)
				if err != nil {
					result.CheckoutStatus = "failed"
					done = true
					return
				}
				result.CheckoutStatus = failureResult.CheckoutStatus
				done = true
			})
		}

		selector.Select(ctx)
	}

	logger.Info("buy_intent_workflow_completed", "command_id", input.CommandID, "status", result.Status)
	return result, nil
}
