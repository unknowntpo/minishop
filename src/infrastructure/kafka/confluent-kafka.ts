export type KafkaMessageHeaderValue = Buffer | string | Array<Buffer | string>;

export type KafkaMessageLike = {
  key?: Buffer | string | null;
  value: Buffer | string | null;
  partition?: number;
  headers?: Record<string, KafkaMessageHeaderValue>;
  timestamp?: string;
};

export type KafkaTopicMessagesLike = {
  topic: string;
  messages: KafkaMessageLike[];
};

export type KafkaProducerLike = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(args: { topic: string; messages: KafkaMessageLike[] }): Promise<unknown>;
  sendBatch(args: { topicMessages?: KafkaTopicMessagesLike[] }): Promise<unknown>;
  flush(args?: { timeout?: number }): Promise<void>;
};

export type KafkaAdminOffsetLike = {
  partition: number;
  offset: string;
  high?: string;
  low?: string;
};

export type KafkaAdminLike = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  createTopics(args: {
    timeout?: number;
    topics: Array<{
      topic: string;
      numPartitions?: number;
      replicationFactor?: number;
    }>;
  }): Promise<boolean>;
  fetchTopicOffsets(topic: string): Promise<KafkaAdminOffsetLike[]>;
};

export type KafkaConsumerLike = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(args: { topic: string }): Promise<void>;
  run(args: {
    partitionsConsumedConcurrently?: number;
    eachMessage: (payload: {
      partition: number;
      message: {
        value: Buffer | null;
        timestamp: string;
        headers?: Record<string, KafkaMessageHeaderValue>;
      };
    }) => Promise<void>;
  }): Promise<void>;
  seek(args: { topic: string; partition: number; offset: string }): void;
};

type KafkaClientLike = {
  producer(config?: Record<string, unknown>): KafkaProducerLike;
  admin(config?: Record<string, unknown>): KafkaAdminLike;
  consumer(config: Record<string, unknown>): KafkaConsumerLike;
};

type KafkaJsCompatModule = {
  Kafka: new (config: Record<string, unknown>) => KafkaClientLike;
  logLevel: {
    NOTHING: number;
  };
};

let sharedModulePromise: Promise<KafkaJsCompatModule> | null = null;

export async function loadConfluentKafkaJsCompat() {
  sharedModulePromise ??= import("@confluentinc/kafka-javascript").then(
    (module) => module.KafkaJS as KafkaJsCompatModule,
  );

  return sharedModulePromise;
}
