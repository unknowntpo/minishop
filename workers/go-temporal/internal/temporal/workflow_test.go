package temporal

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"

	"minishop/workers/go-temporal/internal/contracts"
)

var _ = Describe("BuyIntentCommandWorkflow", func() {
	var (
		suite testsuite.WorkflowTestSuite
		env   *testsuite.TestWorkflowEnvironment
		input contracts.WorkflowInput
	)

	BeforeEach(func() {
		env = suite.NewTestWorkflowEnvironment()
		env.RegisterActivityWithOptions(
			func(ctx context.Context, input StartCheckoutInput) (StartCheckoutResult, error) {
				return StartCheckoutResult{
					CheckoutStatus: "pending_payment",
					PaymentID:      "payment-123",
				}, nil
			},
			activity.RegisterOptions{Name: "start-demo-checkout"},
		)
		env.RegisterActivityWithOptions(
			func(ctx context.Context, input CompletePaymentInput) (CompletePaymentResult, error) {
				return CompletePaymentResult{
					CheckoutStatus: "confirmed",
					OrderID:        "order-123",
					PaymentID:      input.PaymentID,
				}, nil
			},
			activity.RegisterOptions{Name: "complete-payment"},
		)
		env.RegisterActivityWithOptions(
			func(ctx context.Context, input FailPaymentInput) (FailPaymentResult, error) {
				return FailPaymentResult{
					CheckoutStatus: "expired",
					Reason:         input.Reason,
				}, nil
			},
			activity.RegisterOptions{Name: "fail-payment"},
		)
		input = contracts.WorkflowInput{
			CommandID:     "cmd-123",
			CorrelationID: "corr-123",
			IssuedAt:      "2026-04-20T10:00:00Z",
		}
	})

	AfterEach(func() {
		env.AssertExpectations(GinkgoT())
	})

	It("completes after receiving the payment succeeded signal", func() {
		env.RegisterDelayedCallback(func() {
			env.SignalWorkflow(contracts.SignalProcessing, input.CommandID)
			env.SignalWorkflow(contracts.SignalCreated, contracts.CreatedSignalPayload{
				CheckoutIntentID: "checkout-123",
				EventID:          "event-123",
				IsDuplicate:      false,
			})
			env.SignalWorkflow(contracts.SignalPaymentSucceeded, contracts.PaymentSucceededSignalPayload{
				ProviderReference: "provider-123",
			})
		}, time.Millisecond)

		env.ExecuteWorkflow(BuyIntentCommandWorkflow, input)

		Expect(env.IsWorkflowCompleted()).To(BeTrue())
		Expect(env.GetWorkflowError()).NotTo(HaveOccurred())

		var result contracts.WorkflowResult
		Expect(env.GetWorkflowResult(&result)).To(Succeed())
		Expect(result).To(Equal(contracts.WorkflowResult{
			CommandID:        input.CommandID,
			Status:           "created",
			CheckoutIntentID: "checkout-123",
			EventID:          "event-123",
			IsDuplicate:      false,
			CheckoutStatus:   "confirmed",
			OrderID:          "order-123",
			PaymentID:        "payment-123",
		}))
	})

	It("returns the failure payload after receiving the failed signal", func() {
		env.RegisterDelayedCallback(func() {
			env.SignalWorkflow(contracts.SignalFailed, contracts.FailedSignalPayload{
				FailureCode:    contracts.FailureCodeMergeFailed,
				FailureMessage: "append failed",
			})
		}, time.Millisecond)

		env.ExecuteWorkflow(BuyIntentCommandWorkflow, input)

		Expect(env.IsWorkflowCompleted()).To(BeTrue())
		Expect(env.GetWorkflowError()).NotTo(HaveOccurred())

		var result contracts.WorkflowResult
		Expect(env.GetWorkflowResult(&result)).To(Succeed())
		Expect(result).To(Equal(contracts.WorkflowResult{
			CommandID:      input.CommandID,
			Status:         "failed",
			FailureCode:    contracts.FailureCodeMergeFailed,
			FailureMessage: "append failed",
		}))
	})

	It("expires the checkout when payment does not arrive before the timer", func() {
		env.RegisterDelayedCallback(func() {
			env.SignalWorkflow(contracts.SignalCreated, contracts.CreatedSignalPayload{
				CheckoutIntentID: "checkout-123",
				EventID:          "event-123",
				IsDuplicate:      false,
			})
		}, time.Millisecond)

		env.ExecuteWorkflow(BuyIntentCommandWorkflow, input)

		Expect(env.IsWorkflowCompleted()).To(BeTrue())
		Expect(env.GetWorkflowError()).NotTo(HaveOccurred())

		var result contracts.WorkflowResult
		Expect(env.GetWorkflowResult(&result)).To(Succeed())
		Expect(result.CheckoutStatus).To(Equal("expired"))
		Expect(result.PaymentID).To(Equal("payment-123"))
	})
})
