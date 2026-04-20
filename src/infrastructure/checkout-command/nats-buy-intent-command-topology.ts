import "server-only";

import {
  AckPolicy,
  DeliverPolicy,
  JSONCodec,
  RetentionPolicy,
  StorageType,
  connect,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
} from "nats";

import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";

export type NatsBuyIntentCommandTopologyOptions = {
  servers: string;
  streamName: string;
  subject: string;
  durableConsumer?: string;
  ackWaitMs?: number;
  maxDeliver?: number;
};

let sharedConnection: Promise<NatsConnection> | null = null;
let sharedClient: Promise<JetStreamClient> | null = null;
let sharedManager: Promise<JetStreamManager> | null = null;
const ensuredStreams = new Set<string>();
const ensuredConsumers = new Set<string>();

export const buyIntentCommandCodec = JSONCodec<BuyIntentCommand>();

export async function getNatsConnection(servers: string) {
  sharedConnection ??= connect({ servers });
  return sharedConnection;
}

export async function getJetStreamClient(servers: string) {
  sharedClient ??= getNatsConnection(servers).then((nc) => nc.jetstream());
  return sharedClient;
}

export async function getJetStreamManager(servers: string) {
  sharedManager ??= getNatsConnection(servers).then((nc) => nc.jetstreamManager());
  return sharedManager;
}

export async function ensureBuyIntentCommandStream(
  options: NatsBuyIntentCommandTopologyOptions,
) {
  const key = `${options.servers}:${options.streamName}`;

  if (ensuredStreams.has(key)) {
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

  ensuredStreams.add(key);
}

export async function ensureBuyIntentCommandConsumer(
  options: NatsBuyIntentCommandTopologyOptions,
) {
  if (!options.durableConsumer) {
    return;
  }

  await ensureBuyIntentCommandStream(options);

  const key = `${options.servers}:${options.streamName}:${options.durableConsumer}`;

  if (ensuredConsumers.has(key)) {
    return;
  }

  const jsm = await getJetStreamManager(options.servers);

  try {
    await jsm.consumers.info(options.streamName, options.durableConsumer);
  } catch {
    await jsm.consumers.add(options.streamName, {
      durable_name: options.durableConsumer,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: options.subject,
      ack_wait: (options.ackWaitMs ?? 30_000) * 1_000_000,
      max_deliver: options.maxDeliver ?? -1,
    });
  }

  ensuredConsumers.add(key);
}
