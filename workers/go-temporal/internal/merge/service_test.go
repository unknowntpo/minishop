package merge

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	"github.com/stretchr/testify/mock"
	sdkclient "go.temporal.io/sdk/client"
	sdkmocks "go.temporal.io/sdk/mocks"
	"go.uber.org/zap"

	"minishop/workers/go-temporal/internal/contracts"
)

var _ = Describe("Service signalWithStart", func() {
	var (
		service      *Service
		temporalMock *sdkmocks.Client
		workflowRun  *sdkmocks.WorkflowRun
		ctx          context.Context
	)

	BeforeEach(func() {
		ctx = context.Background()
		temporalMock = sdkmocks.NewClient(GinkgoT())
		workflowRun = sdkmocks.NewWorkflowRun(GinkgoT())
		service = &Service{
			temporal:  temporalMock,
			logger:    zap.NewNop(),
			taskQueue: contracts.TaskQueue,
		}
	})

	It("starts or signals the workflow with the created payload and preserves a valid issued_at", func() {
		command := contracts.BuyIntentCommand{
			CommandID:     "cmd-created-123",
			CorrelationID: "corr-created-123",
			IssuedAt:      "2026-04-20T10:00:00Z",
		}
		result := appendResult{
			CheckoutIntentID: "checkout-123",
			EventID:          "event-123",
			IsDuplicate:      true,
		}

		temporalMock.
			On(
				"SignalWithStartWorkflow",
				mock.Anything,
				contracts.WorkflowID(command.CommandID),
				contracts.SignalCreated,
				contracts.CreatedSignalPayload{
					CheckoutIntentID: result.CheckoutIntentID,
					EventID:          result.EventID,
					IsDuplicate:      result.IsDuplicate,
				},
				mock.MatchedBy(func(options sdkclient.StartWorkflowOptions) bool {
					return options.ID == contracts.WorkflowID(command.CommandID) &&
						options.TaskQueue == contracts.TaskQueue
				}),
				contracts.WorkflowName,
				contracts.WorkflowInput{
					CommandID:     command.CommandID,
					CorrelationID: command.CorrelationID,
					IssuedAt:      command.IssuedAt,
				},
			).
			Return(workflowRun, nil).
			Once()

		service.signalCreated(ctx, command, result)
	})

	It("falls back to the current time when issued_at is invalid", func() {
		command := contracts.BuyIntentCommand{
			CommandID:     "cmd-failed-123",
			CorrelationID: "corr-failed-123",
			IssuedAt:      "not-a-timestamp",
		}

		before := time.Now().UTC()

		temporalMock.
			On(
				"SignalWithStartWorkflow",
				mock.Anything,
				contracts.WorkflowID(command.CommandID),
				contracts.SignalFailed,
				contracts.FailedSignalPayload{
					FailureCode:    contracts.FailureCodeMergeFailed,
					FailureMessage: "merge exploded",
				},
				mock.MatchedBy(func(options sdkclient.StartWorkflowOptions) bool {
					return options.ID == contracts.WorkflowID(command.CommandID) &&
						options.TaskQueue == contracts.TaskQueue
				}),
				contracts.WorkflowName,
				mock.MatchedBy(func(input contracts.WorkflowInput) bool {
					if input.CommandID != command.CommandID || input.CorrelationID != command.CorrelationID {
						return false
					}
					issuedAt, err := time.Parse(time.RFC3339, input.IssuedAt)
					if err != nil {
						return false
					}
					return !issuedAt.Before(before.Add(-time.Second)) &&
						!issuedAt.After(time.Now().UTC().Add(time.Second))
				}),
			).
			Return(workflowRun, nil).
			Once()

		service.signalFailed(ctx, command, contracts.FailureCodeMergeFailed, "merge exploded")
	})
})
