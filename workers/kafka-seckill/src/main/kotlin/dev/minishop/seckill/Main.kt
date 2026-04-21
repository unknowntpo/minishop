package dev.minishop.seckill

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.common.serialization.Serdes
import org.apache.kafka.streams.KafkaStreams
import org.apache.kafka.streams.errors.StreamsUncaughtExceptionHandler
import org.apache.kafka.streams.KeyValue
import org.apache.kafka.streams.StreamsBuilder
import org.apache.kafka.streams.StreamsConfig
import org.apache.kafka.streams.kstream.Transformer
import org.apache.kafka.streams.kstream.TransformerSupplier
import org.apache.kafka.streams.state.KeyValueStore
import org.apache.kafka.streams.state.Stores
import org.slf4j.LoggerFactory
import java.net.URI
import java.sql.Connection
import java.sql.DriverManager
import java.sql.Timestamp
import java.time.Instant
import java.util.Properties
import java.util.UUID
import java.util.concurrent.CountDownLatch

private val mapper = jacksonObjectMapper()
private val logger = LoggerFactory.getLogger("minishop-seckill")

private const val INVENTORY_STORE_NAME = "inventory-store"
private const val DEDUPE_STORE_NAME = "dedupe-store"

fun main() {
    val config = AppConfig.fromEnv()
    val gateway = PostgresGateway(config)

    val builder = StreamsBuilder()
    val inventoryStore = Stores.keyValueStoreBuilder(
        Stores.persistentKeyValueStore(INVENTORY_STORE_NAME),
        Serdes.String(),
        Serdes.String()
    )
    val dedupeStore = Stores.keyValueStoreBuilder(
        Stores.persistentKeyValueStore(DEDUPE_STORE_NAME),
        Serdes.String(),
        Serdes.String()
    )

    builder.addStateStore(inventoryStore)
    builder.addStateStore(dedupeStore)

    builder.stream<String, String>(config.requestTopic)
        .transform(
            TransformerSupplier {
                SeckillDecisionTransformer(config, gateway)
            },
            INVENTORY_STORE_NAME,
            DEDUPE_STORE_NAME
        )
        .to(config.resultTopic)

    val streams = KafkaStreams(builder.build(), config.streamProperties())
    val shutdownLatch = CountDownLatch(1)

    streams.setStateListener { newState, oldState ->
        logger.info("Kafka Streams state changed: {} -> {}", oldState, newState)
    }
    streams.setUncaughtExceptionHandler { throwable ->
        logger.error("Kafka seckill worker crashed", throwable)
        shutdownLatch.countDown()
        StreamsUncaughtExceptionHandler.StreamThreadExceptionResponse.SHUTDOWN_APPLICATION
    }
    Runtime.getRuntime().addShutdownHook(Thread {
        logger.info("Stopping Kafka seckill worker")
        streams.close()
        shutdownLatch.countDown()
    })
    logger.info(
        "Starting Kafka seckill worker appId={} brokers={} requestTopic={} resultTopic={} stateDir={}",
        config.applicationId,
        config.brokers,
        config.requestTopic,
        config.resultTopic,
        config.stateDir,
    )
    streams.start()
    shutdownLatch.await()
}

data class AppConfig(
    val brokers: String,
    val applicationId: String,
    val requestTopic: String,
    val resultTopic: String,
    val stateDir: String,
    val jdbcUrl: String,
    val jdbcUser: String,
    val jdbcPassword: String,
) {
    fun streamProperties(): Properties =
        Properties().apply {
            put(StreamsConfig.APPLICATION_ID_CONFIG, applicationId)
            put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, brokers)
            put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.StringSerde::class.java)
            put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.StringSerde::class.java)
            put(StreamsConfig.NUM_STREAM_THREADS_CONFIG, "1")
            put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, StreamsConfig.EXACTLY_ONCE_V2)
            put(StreamsConfig.STATE_DIR_CONFIG, stateDir)
            put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
        }

    companion object {
        fun fromEnv(): AppConfig {
            val jdbcUrl = env("JDBC_DATABASE_URL")
            return AppConfig(
                brokers = env("KAFKA_BROKERS"),
                applicationId = env("KAFKA_SECKILL_APPLICATION_ID", "minishop-seckill-worker"),
                requestTopic = env("KAFKA_SECKILL_REQUEST_TOPIC", "inventory.seckill.requested"),
                resultTopic = env("KAFKA_SECKILL_RESULT_TOPIC", "inventory.seckill.result"),
                stateDir = env("KAFKA_SECKILL_STATE_DIR", "/var/lib/minishop-seckill/state"),
                jdbcUrl = jdbcUrl,
                jdbcUser = env("DATABASE_USER", "postgres"),
                jdbcPassword = env("DATABASE_PASSWORD", "postgres"),
            )
        }

        private fun env(name: String, default: String? = null): String =
            System.getenv(name)?.trim()?.takeIf { it.isNotEmpty() }
                ?: default
                ?: error("$name is required")
    }
}

class SeckillDecisionTransformer(
    private val config: AppConfig,
    private val gateway: PostgresGateway,
) : Transformer<String, String, KeyValue<String, String>> {
    private lateinit var inventoryStore: KeyValueStore<String, String>
    private lateinit var dedupeStore: KeyValueStore<String, String>

    override fun init(context: org.apache.kafka.streams.processor.ProcessorContext) {
        @Suppress("UNCHECKED_CAST")
        inventoryStore = context.getStateStore(INVENTORY_STORE_NAME) as KeyValueStore<String, String>
        @Suppress("UNCHECKED_CAST")
        dedupeStore = context.getStateStore(DEDUPE_STORE_NAME) as KeyValueStore<String, String>
    }

    override fun transform(key: String, value: String): KeyValue<String, String>? {
        val request = mapper.readValue<SeckillBuyIntentRequest>(value)
        val dedupeKey = request.command.idempotency_key ?: request.command.command_id
        val storedResult = dedupeStore.get(dedupeKey)?.let { mapper.readValue<SeckillCommandResult>(it) }

        if (storedResult != null) {
            gateway.persistForDuplicateCommand(request, storedResult)
            return KeyValue.pair(key, mapper.writeValueAsString(storedResult))
        }

        var state = inventoryStore.get(request.sku_id)
            ?.let { mapper.readValue<SeckillInventoryState>(it) }
            ?: gateway.loadInitialState(request.sku_id, request.seckill_stock_limit)
            ?: SeckillInventoryState(
                skuId = request.sku_id,
                projectionAvailableRemaining = 0,
                configuredStockLimit = request.seckill_stock_limit,
                acceptedUnits = 0,
            )

        if (state.configuredStockLimit != request.seckill_stock_limit) {
            state = state.copy(configuredStockLimit = request.seckill_stock_limit)
        }

        val effectiveRemaining = minOf(
            state.projectionAvailableRemaining,
            (state.configuredStockLimit - state.acceptedUnits).coerceAtLeast(0),
        )

        val result =
            if (request.quantity <= effectiveRemaining) {
                val checkoutIntentId = UUID.randomUUID().toString()
                val eventId = UUID.randomUUID().toString()
                val acceptedState = state.copy(
                    projectionAvailableRemaining = (state.projectionAvailableRemaining - request.quantity).coerceAtLeast(0),
                    acceptedUnits = state.acceptedUnits + request.quantity,
                )
                state = acceptedState
                SeckillCommandResult(
                    commandId = request.command.command_id,
                    correlationId = request.command.correlation_id,
                    skuId = request.sku_id,
                    checkoutIntentId = checkoutIntentId,
                    status = "reserved",
                    requestedQuantity = request.quantity,
                    seckillStockLimit = request.seckill_stock_limit,
                    failureReason = null,
                    eventId = eventId,
                    duplicate = false,
                ).also {
                    gateway.persistCreated(request, it)
                }
            } else {
                SeckillCommandResult(
                    commandId = request.command.command_id,
                    correlationId = request.command.correlation_id,
                    skuId = request.sku_id,
                    checkoutIntentId = null,
                    status = "rejected",
                    requestedQuantity = request.quantity,
                    seckillStockLimit = request.seckill_stock_limit,
                    failureReason = "seckill_out_of_stock",
                    eventId = null,
                    duplicate = false,
                ).also {
                    gateway.persistRejected(request, it)
                }
            }

        inventoryStore.put(request.sku_id, mapper.writeValueAsString(state))
        dedupeStore.put(dedupeKey, mapper.writeValueAsString(result))

        return KeyValue.pair(key, mapper.writeValueAsString(result))
    }

    override fun close() = Unit
}

@JsonIgnoreProperties(ignoreUnknown = true)
data class SeckillBuyIntentRequest(
    val sku_id: String,
    val quantity: Int,
    val seckill_stock_limit: Int,
    val command: BuyIntentCommand,
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class BuyIntentCommand(
    val command_id: String,
    val correlation_id: String,
    val buyer_id: String,
    val items: List<CheckoutItem>,
    val idempotency_key: String? = null,
    val metadata: EventMetadata,
    val issued_at: String,
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class CheckoutItem(
    val sku_id: String,
    val quantity: Int,
    val unit_price_amount_minor: Int,
    val currency: String,
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class EventMetadata(
    val request_id: String,
    val trace_id: String,
    val source: String,
    val actor_id: String,
)

data class SeckillInventoryState(
    val skuId: String,
    val projectionAvailableRemaining: Int,
    val configuredStockLimit: Int,
    val acceptedUnits: Int,
)

data class SeckillCommandResult(
    val commandId: String,
    val correlationId: String,
    val skuId: String,
    val checkoutIntentId: String?,
    val status: String,
    val requestedQuantity: Int,
    val seckillStockLimit: Int,
    val failureReason: String?,
    val eventId: String?,
    val duplicate: Boolean,
)

class PostgresGateway(private val config: AppConfig) {
    fun loadInitialState(skuId: String, stockLimit: Int): SeckillInventoryState? =
        connection().use { connection ->
            connection.prepareStatement(
                """
                select
                  sku_inventory_projection.available,
                  coalesce(sku.seckill_stock_limit, ?) as seckill_stock_limit
                from sku
                left join sku_inventory_projection on sku_inventory_projection.sku_id = sku.sku_id
                where sku.sku_id = ?
                  and sku.seckill_candidate = true
                limit 1
                """.trimIndent()
            ).use { statement ->
                statement.setInt(1, stockLimit)
                statement.setString(2, skuId)
                statement.executeQuery().use { result ->
                    if (!result.next()) {
                        null
                    } else {
                        SeckillInventoryState(
                            skuId = skuId,
                            projectionAvailableRemaining = result.getInt("available"),
                            configuredStockLimit = result.getInt("seckill_stock_limit"),
                            acceptedUnits = 0,
                        )
                    }
                }
            }
        }

    fun persistCreated(request: SeckillBuyIntentRequest, result: SeckillCommandResult) {
        connection().use { connection ->
            connection.autoCommit = false
            try {
                upsertCheckoutIntentCreated(connection, request, result)
                upsertCommandStatusCreated(connection, request, result, duplicate = false)
                upsertSeckillResult(connection, result)
                connection.commit()
            } catch (error: Throwable) {
                connection.rollback()
                throw error
            } finally {
                connection.autoCommit = true
            }
        }
    }

    fun persistRejected(request: SeckillBuyIntentRequest, result: SeckillCommandResult) {
        connection().use { connection ->
            connection.autoCommit = false
            try {
                upsertCommandStatusFailed(connection, request, result, duplicate = false)
                upsertSeckillResult(connection, result)
                connection.commit()
            } catch (error: Throwable) {
                connection.rollback()
                throw error
            } finally {
                connection.autoCommit = true
            }
        }
    }

    fun persistForDuplicateCommand(request: SeckillBuyIntentRequest, result: SeckillCommandResult) {
        val duplicateResult = result.copy(
            commandId = request.command.command_id,
            correlationId = request.command.correlation_id,
            duplicate = true,
        )

        connection().use { connection ->
            connection.autoCommit = false
            try {
                if (duplicateResult.status == "reserved") {
                    upsertCommandStatusCreated(connection, request, duplicateResult, duplicate = true)
                } else {
                    upsertCommandStatusFailed(connection, request, duplicateResult, duplicate = true)
                }
                upsertSeckillResult(connection, duplicateResult)
                connection.commit()
            } catch (error: Throwable) {
                connection.rollback()
                throw error
            } finally {
                connection.autoCommit = true
            }
        }
    }

    private fun upsertCheckoutIntentCreated(
        connection: Connection,
        request: SeckillBuyIntentRequest,
        result: SeckillCommandResult,
    ) {
        val payload = mapper.writeValueAsString(
            mapOf(
                "checkout_intent_id" to result.checkoutIntentId,
                "buyer_id" to request.command.buyer_id,
                "items" to request.command.items,
                "idempotency_key" to request.command.idempotency_key,
            )
        )
        val metadata = mapper.writeValueAsString(
            mapOf(
                "request_id" to request.command.metadata.request_id,
                "trace_id" to request.command.metadata.trace_id,
                "source" to request.command.metadata.source,
                "actor_id" to request.command.metadata.actor_id,
            )
        )
        val occurredAt = Instant.now()

        connection.prepareStatement(
            """
            insert into event_store (
              event_id,
              event_type,
              event_version,
              aggregate_type,
              aggregate_id,
              aggregate_version,
              payload,
              metadata,
              idempotency_key,
              occurred_at
            )
            values (?, 'CheckoutIntentCreated', 1, 'checkout', ?, 1, ?::jsonb, ?::jsonb, ?, ?)
            on conflict (idempotency_key)
              where idempotency_key is not null
              do nothing
            """.trimIndent()
        ).use { statement ->
            statement.setObject(1, UUID.fromString(result.eventId))
            statement.setObject(2, UUID.fromString(result.checkoutIntentId))
            statement.setString(3, payload)
            statement.setString(4, metadata)
            statement.setString(5, request.command.idempotency_key)
            statement.setTimestamp(6, Timestamp.from(occurredAt))
            statement.executeUpdate()
        }
    }

    private fun upsertCommandStatusCreated(
        connection: Connection,
        request: SeckillBuyIntentRequest,
        result: SeckillCommandResult,
        duplicate: Boolean,
    ) {
        connection.prepareStatement(
            """
            insert into command_status (
              command_id,
              correlation_id,
              idempotency_key,
              status,
              checkout_intent_id,
              event_id,
              is_duplicate,
              failure_code,
              failure_message
            )
            values (?, ?, ?, 'created', ?, ?, ?, null, null)
            on conflict (command_id)
            do update set
              correlation_id = excluded.correlation_id,
              idempotency_key = excluded.idempotency_key,
              status = excluded.status,
              checkout_intent_id = excluded.checkout_intent_id,
              event_id = excluded.event_id,
              is_duplicate = excluded.is_duplicate,
              failure_code = null,
              failure_message = null,
              updated_at = now()
            """.trimIndent()
        ).use { statement ->
            statement.setObject(1, UUID.fromString(request.command.command_id))
            statement.setObject(2, UUID.fromString(request.command.correlation_id))
            statement.setString(3, request.command.idempotency_key)
            statement.setObject(4, UUID.fromString(result.checkoutIntentId))
            statement.setObject(5, UUID.fromString(result.eventId))
            statement.setBoolean(6, duplicate)
            statement.executeUpdate()
        }
    }

    private fun upsertCommandStatusFailed(
        connection: Connection,
        request: SeckillBuyIntentRequest,
        result: SeckillCommandResult,
        duplicate: Boolean,
    ) {
        connection.prepareStatement(
            """
            insert into command_status (
              command_id,
              correlation_id,
              idempotency_key,
              status,
              is_duplicate,
              failure_code,
              failure_message
            )
            values (?, ?, ?, 'failed', ?, 'seckill_out_of_stock', ?)
            on conflict (command_id)
            do update set
              correlation_id = excluded.correlation_id,
              idempotency_key = excluded.idempotency_key,
              status = excluded.status,
              is_duplicate = excluded.is_duplicate,
              failure_code = excluded.failure_code,
              failure_message = excluded.failure_message,
              updated_at = now()
            """.trimIndent()
        ).use { statement ->
            statement.setObject(1, UUID.fromString(request.command.command_id))
            statement.setObject(2, UUID.fromString(request.command.correlation_id))
            statement.setString(3, request.command.idempotency_key)
            statement.setBoolean(4, duplicate)
            statement.setString(5, result.failureReason ?: "seckill_out_of_stock")
            statement.executeUpdate()
        }
    }

    private fun upsertSeckillResult(connection: Connection, result: SeckillCommandResult) {
        connection.prepareStatement(
            """
            insert into seckill_command_result (
              command_id,
              correlation_id,
              sku_id,
              checkout_intent_id,
              status,
              requested_quantity,
              seckill_stock_limit,
              failure_reason
            )
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (command_id)
            do update set
              correlation_id = excluded.correlation_id,
              sku_id = excluded.sku_id,
              checkout_intent_id = excluded.checkout_intent_id,
              status = excluded.status,
              requested_quantity = excluded.requested_quantity,
              seckill_stock_limit = excluded.seckill_stock_limit,
              failure_reason = excluded.failure_reason,
              updated_at = now()
            """.trimIndent()
        ).use { statement ->
            statement.setObject(1, UUID.fromString(result.commandId))
            statement.setObject(2, UUID.fromString(result.correlationId))
            statement.setString(3, result.skuId)
            if (result.checkoutIntentId == null) {
                statement.setObject(4, null)
            } else {
                statement.setObject(4, UUID.fromString(result.checkoutIntentId))
            }
            statement.setString(5, result.status)
            statement.setInt(6, result.requestedQuantity)
            statement.setInt(7, result.seckillStockLimit)
            statement.setString(8, result.failureReason)
            statement.executeUpdate()
        }
    }

    private fun connection(): Connection =
        DriverManager.getConnection(config.jdbcUrl, config.jdbcUser, config.jdbcPassword)
}
