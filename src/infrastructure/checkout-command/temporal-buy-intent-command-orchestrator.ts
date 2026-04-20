import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";

import {
  buyIntentTemporalSignals,
  buyIntentTemporalTaskQueue,
  buyIntentTemporalWorkflowId,
  buyIntentTemporalWorkflowName,
} from "@/src/domain/checkout-command/temporal-contract";
import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { BuyIntentCommandOrchestrator } from "@/src/ports/buy-intent-command-orchestrator";

type TemporalWorkflowHandleLike = {
  signal(signalName: string, ...args: unknown[]): Promise<unknown>;
};

type TemporalWorkflowStarterLike = {
  start(
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
  ): Promise<unknown>;
  getHandle(workflowId: string): TemporalWorkflowHandleLike;
};

type TemporalClientLike = {
  workflow: TemporalWorkflowStarterLike;
};

export function createTemporalBuyIntentCommandOrchestrator(input: {
  address: string;
  namespace?: string;
  taskQueue?: string;
  client?: TemporalClientLike;
}): BuyIntentCommandOrchestrator {
  const taskQueue = input.taskQueue?.trim() || buyIntentTemporalTaskQueue;
  let sharedClient: Promise<TemporalClientLike> | null = null;

  function getClient() {
    if (input.client) {
      return Promise.resolve(input.client);
    }

    sharedClient ??= createTemporalClient({
      address: input.address,
      namespace: input.namespace,
    });

    return sharedClient;
  }

  return {
    async start(command) {
      const client = await getClient();

      try {
        await client.workflow.start(buyIntentTemporalWorkflowName, {
          taskQueue,
          workflowId: buyIntentTemporalWorkflowId(command.command_id),
          args: [
            {
              commandId: command.command_id,
              correlationId: command.correlation_id,
              issuedAt: command.issued_at,
            },
          ],
        });
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          return;
        }

        throw error;
      }
    },

    async markProcessing(commandId) {
      const client = await getClient();
      await client.workflow
        .getHandle(buyIntentTemporalWorkflowId(commandId))
        .signal(buyIntentTemporalSignals.processing, commandId);
    },

    async markCreated({ commandId, checkoutIntentId, eventId, isDuplicate }) {
      const client = await getClient();
      await client.workflow
        .getHandle(buyIntentTemporalWorkflowId(commandId))
        .signal(buyIntentTemporalSignals.created, {
          checkoutIntentId,
          eventId,
          isDuplicate,
        });
    },

    async markFailed({ commandId, failureCode, failureMessage }) {
      const client = await getClient();
      await client.workflow
        .getHandle(buyIntentTemporalWorkflowId(commandId))
        .signal(buyIntentTemporalSignals.failed, {
          failureCode,
          failureMessage,
        });
    },
  };
}

async function createTemporalClient(input: {
  address: string;
  namespace?: string;
}): Promise<TemporalClientLike> {
  const connection = await Connection.connect({
    address: input.address,
  });

  return new Client({
    connection,
    ...(input.namespace?.trim() ? { namespace: input.namespace } : {}),
  });
}

export async function signalTemporalBuyIntentWorkflow(input: {
  address: string;
  namespace?: string;
  commandId: string;
  signalName: string;
  signalArgs: unknown[];
}) {
  const client = await createTemporalClient({
    address: input.address,
    namespace: input.namespace,
  });

  await client.workflow
    .getHandle(buyIntentTemporalWorkflowId(input.commandId))
    .signal(input.signalName, ...input.signalArgs);
}
