import { Kafka, type Admin, type Producer, logLevel } from "kafkajs";

import type { SeckillBuyIntentRequest } from "@/src/domain/seckill/seckill-buy-intent-request";

export type KafkaSeckillProducerOptions = {
  brokers: string[];
  requestTopic: string;
  resultTopic: string;
  clientId?: string;
};

export type SeckillPendingMessage = {
  request: SeckillBuyIntentRequest;
  headers: Record<string, Buffer>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class KafkaSeckillProducer {
  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private admin: Admin | null = null;
  private topicsEnsured: Promise<void> | null = null;

  constructor(private readonly options: KafkaSeckillProducerOptions) {}

  async send(entries: SeckillPendingMessage[]) {
    await this.ensureTopics();

    const execute = async () => {
      const producer = await this.getProducer();
      await producer.sendBatch({
        topicMessages: [
          {
            topic: this.options.requestTopic,
            messages: entries.map((entry) => ({
              key: entry.request.processing_key,
              value: JSON.stringify(entry.request),
              headers: entry.headers,
            })),
          },
        ],
      });
    };

    try {
      await execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("disconnected")) {
        throw error;
      }

      await this.resetProducer();
      await execute();
    }
  }

  private getKafka() {
    this.kafka ??= new Kafka({
      clientId: this.options.clientId ?? "minishop-seckill-app",
      brokers: this.options.brokers,
      logLevel: logLevel.NOTHING,
    });
    return this.kafka;
  }

  private async getProducer() {
    if (this.producer) {
      await this.producer.connect();
      return this.producer;
    }

    this.producer = this.getKafka().producer({
      allowAutoTopicCreation: true,
    });
    await this.producer.connect();
    return this.producer;
  }

  private async resetProducer() {
    const producer = this.producer;
    this.producer = null;
    if (!producer) {
      return;
    }

    try {
      await producer.disconnect();
    } catch {
      // Ignore disconnect races while replacing a stale shared producer.
    }
  }

  private async getAdmin() {
    if (this.admin) {
      return this.admin;
    }

    this.admin = this.getKafka().admin();
    await this.admin.connect();
    return this.admin;
  }

  private async ensureTopics() {
    if (this.topicsEnsured) {
      return this.topicsEnsured;
    }

    this.topicsEnsured = (async () => {
      const admin = await this.getAdmin();
      await admin.createTopics({
        waitForLeaders: true,
        topics: [
          {
            topic: this.options.requestTopic,
            numPartitions: 6,
            replicationFactor: 1,
          },
          {
            topic: this.options.resultTopic,
            numPartitions: 6,
            replicationFactor: 1,
          },
        ],
      });
    })();

    return this.topicsEnsured;
  }
}
