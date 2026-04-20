import "server-only";

import {
  connect,
  JSONCodec,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
} from "nats";

import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";

type NatsBuyIntentCommandBusOptions = {
  servers: string;
  streamName: string;
  subject: string;
};

let sharedConnection: Promise<NatsConnection> | null = null;
let sharedClient: Promise<JetStreamClient> | null = null;
let sharedManager: Promise<JetStreamManager> | null = null;
const codec = JSONCodec<BuyIntentCommand>();
const ensuredStreams = new Set<string>();

export function createNatsBuyIntentCommandBus(
  options: NatsBuyIntentCommandBusOptions,
): BuyIntentCommandBus {
  return {
    async publish(command) {
      const js = await getJetStreamClient(options.servers);
      await ensureStream(options);
      await js.publish(options.subject, codec.encode(command));
    },
  };
}

async function getConnection(servers: string) {
  sharedConnection ??= connect({ servers });
  return sharedConnection;
}

async function getJetStreamClient(servers: string) {
  sharedClient ??= getConnection(servers).then((nc) => nc.jetstream());
  return sharedClient;
}

async function getJetStreamManager(servers: string) {
  sharedManager ??= getConnection(servers).then((nc) => nc.jetstreamManager());
  return sharedManager;
}

async function ensureStream(options: NatsBuyIntentCommandBusOptions) {
  if (ensuredStreams.has(options.streamName)) {
    return;
  }

  const jsm = await getJetStreamManager(options.servers);

  try {
    await jsm.streams.info(options.streamName);
  } catch {
    await jsm.streams.add({
      name: options.streamName,
      subjects: [options.subject],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
    });
  }

  ensuredStreams.add(options.streamName);
}
