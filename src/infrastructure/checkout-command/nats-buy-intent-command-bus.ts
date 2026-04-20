import {
  buyIntentCommandCodec,
  ensureBuyIntentCommandStream,
  getJetStreamClient,
} from "@/src/infrastructure/checkout-command/nats-buy-intent-command-topology";
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
      const js = await getJetStreamClient(options.servers);
      await ensureBuyIntentCommandStream(options);
      await js.publish(options.subject, buyIntentCommandCodec.encode(command), {
        msgID: command.command_id,
      });
    },
  };
}
