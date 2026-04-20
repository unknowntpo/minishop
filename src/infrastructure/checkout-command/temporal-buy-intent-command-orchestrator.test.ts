import { describe, expect, it } from "vitest";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";

import {
  buyIntentTemporalSignals,
  buyIntentTemporalTaskQueue,
  buyIntentTemporalWorkflowId,
  buyIntentTemporalWorkflowName,
} from "@/src/domain/checkout-command/temporal-contract";
import { createTemporalBuyIntentCommandOrchestrator } from "@/src/infrastructure/checkout-command/temporal-buy-intent-command-orchestrator";

describe("createTemporalBuyIntentCommandOrchestrator", () => {
  it("starts the buy-intent workflow with stable workflow identity", async () => {
    const client = new FakeTemporalClient();
    const orchestrator = createTemporalBuyIntentCommandOrchestrator({
      address: "localhost:7233",
      client,
    });

    await orchestrator.start(buildCommand("cmd_1"));

    expect(client.started[0]).toEqual({
      workflowType: buyIntentTemporalWorkflowName,
      options: {
        taskQueue: buyIntentTemporalTaskQueue,
        workflowId: buyIntentTemporalWorkflowId("cmd_1"),
        args: [
          {
            commandId: "cmd_1",
            correlationId: "corr_cmd_1",
            issuedAt: "2026-04-20T12:00:00.000Z",
          },
        ],
      },
    });
  });

  it("treats already-started workflow as benign duplicate start", async () => {
    const client = new FakeTemporalClient();
    client.startError = new WorkflowExecutionAlreadyStartedError(
      "Workflow execution already started",
      buyIntentTemporalWorkflowId("cmd_2"),
      buyIntentTemporalWorkflowName,
    );
    const orchestrator = createTemporalBuyIntentCommandOrchestrator({
      address: "localhost:7233",
      client,
    });

    await expect(orchestrator.start(buildCommand("cmd_2"))).resolves.toBeUndefined();
  });

  it("signals workflow lifecycle transitions", async () => {
    const client = new FakeTemporalClient();
    const orchestrator = createTemporalBuyIntentCommandOrchestrator({
      address: "localhost:7233",
      client,
    });

    await orchestrator.markProcessing("cmd_3");
    await orchestrator.markCreated({
      commandId: "cmd_3",
      checkoutIntentId: "chk_3",
      eventId: "evt_3",
      isDuplicate: true,
    });
    await orchestrator.markFailed({
      commandId: "cmd_3",
      failureCode: "merge_failed",
      failureMessage: "failed",
    });

    expect(client.signals).toEqual([
      {
        workflowId: buyIntentTemporalWorkflowId("cmd_3"),
        signalName: buyIntentTemporalSignals.processing,
        args: ["cmd_3"],
      },
      {
        workflowId: buyIntentTemporalWorkflowId("cmd_3"),
        signalName: buyIntentTemporalSignals.created,
        args: [
          {
            checkoutIntentId: "chk_3",
            eventId: "evt_3",
            isDuplicate: true,
          },
        ],
      },
      {
        workflowId: buyIntentTemporalWorkflowId("cmd_3"),
        signalName: buyIntentTemporalSignals.failed,
        args: [
          {
            failureCode: "merge_failed",
            failureMessage: "failed",
          },
        ],
      },
    ]);
  });
});

class FakeTemporalClient {
  readonly started: Array<{
    workflowType: string;
    options: {
      taskQueue: string;
      workflowId: string;
      args: Array<{
        commandId: string;
        correlationId: string;
        issuedAt: string;
      }>;
    };
  }> = [];
  readonly signals: Array<{
    workflowId: string;
    signalName: string;
    args: unknown[];
  }> = [];
  startError: Error | null = null;

  readonly workflow = {
    start: async (
      workflowType: string,
      options: {
        taskQueue: string;
        workflowId: string;
        args: Array<{
          commandId: string;
          correlationId: string;
          issuedAt: string;
        }>;
      },
    ) => {
      if (this.startError) {
        throw this.startError;
      }

      this.started.push({ workflowType, options });
    },
    getHandle: (workflowId: string) => ({
      signal: async (signalName: string, ...args: unknown[]) => {
        this.signals.push({ workflowId, signalName, args });
      },
    }),
  };
}

function buildCommand(commandId: string) {
  return {
    command_id: commandId,
    correlation_id: `corr_${commandId}`,
    buyer_id: "buyer_1",
    items: [
      {
        sku_id: "sku_hot_001",
        quantity: 1,
        unit_price_amount_minor: 1200,
        currency: "TWD" as const,
      },
    ],
    idempotency_key: `idem_${commandId}`,
    metadata: {
      request_id: `req_${commandId}`,
      trace_id: `trace_${commandId}`,
      source: "web" as const,
      actor_id: "buyer_1",
    },
    issued_at: "2026-04-20T12:00:00.000Z",
  };
}
