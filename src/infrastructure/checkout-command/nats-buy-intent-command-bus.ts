import { headers } from "nats";

import {
  buyIntentCommandCodec,
  ensureBuyIntentCommandStream,
  getJetStreamClient,
} from "@/src/infrastructure/checkout-command/nats-buy-intent-command-topology";
import { assertValidBuyIntentCommandContract } from "@/src/contracts/buy-intent-command-contract";
import { injectTraceCarrierToNatsHeaders, withSpan } from "@/src/infrastructure/telemetry/otel";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";

type NatsBuyIntentCommandBusOptions = {
  servers: string;
  streamName: string;
  subject: string;
  retrySubject?: string;
  dlqSubject?: string;
};

export function createNatsBuyIntentCommandBus(
  options: NatsBuyIntentCommandBusOptions,
): BuyIntentCommandBus {
  return {
    async publish(command) {
      assertValidBuyIntentCommandContract(command);
      await withSpan(
        "buy_intent.publish",
        {
          attributes: {
            "messaging.system": "nats",
            "messaging.operation": "publish",
            "messaging.destination.name": options.subject,
            "buy_intent.command_id": command.command_id,
          },
        },
        async () => {
          const js = await getJetStreamClient(options.servers);
          await ensureBuyIntentCommandStream(options);
          await js.publish(options.subject, buyIntentCommandCodec.encode(command), {
            msgID: command.command_id,
            headers: injectTraceCarrierToNatsHeaders(headers()),
          });
        },
      );
    },
  };
}
