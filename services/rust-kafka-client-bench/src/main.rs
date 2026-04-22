use std::cmp::Ordering;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
use rdkafka::client::DefaultClientContext;
use rdkafka::config::ClientConfig;
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::util::Timeout;
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::Semaphore;

#[derive(Clone)]
struct Config {
    brokers: Vec<String>,
    client: String,
    compression: String,
    concurrency: usize,
    linger_ms: u64,
    message_bytes: usize,
    messages: usize,
    partitions: i32,
    replication: i32,
    results_dir: String,
    run_id: String,
    scenario_name: String,
    topic: String,
    topic_prefix: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    schema_version: u32,
    run_id: String,
    scenario_name: String,
    scenario_tags: serde_json::Value,
    started_at: String,
    finished_at: String,
    pass: bool,
    environment: serde_json::Value,
    request_path: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<serde_json::Value>,
    diagnostics: serde_json::Value,
    measurements: Vec<serde_json::Value>,
}

#[tokio::main]
async fn main() {
    let cfg = read_config();
    let started_wall = now_rfc3339_like();
    let started_at = Instant::now();

    if let Err(err) = ensure_topic(&cfg).await {
        let _ = write_failure_artifact(&cfg, &started_wall, format!("ensure topic: {err}"));
        eprintln!("ensure topic: {err}");
        std::process::exit(1);
    }

    match run_benchmark(&cfg, started_at, started_wall.clone()).await {
        Ok(path) => println!("artifact written to {}", path.display()),
        Err(err) => {
            let _ = write_failure_artifact(&cfg, &started_wall, err.to_string());
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}

async fn run_benchmark(
    cfg: &Config,
    started_at: Instant,
    started_wall: String,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", cfg.brokers.join(","))
        .set("client.id", "rust-kafka-client-bench-rdkafka")
        .set("acks", "all")
        .set("linger.ms", cfg.linger_ms.to_string())
        .set("compression.type", cfg.compression.as_str())
        .set("message.timeout.ms", "30000")
        .create()?;

    let semaphore = Arc::new(Semaphore::new(cfg.concurrency));
    let mut tasks = Vec::with_capacity(cfg.messages);

    for index in 0..cfg.messages {
        let permit = semaphore.clone().acquire_owned().await?;
        let producer = producer.clone();
        let topic = topic_name(cfg);
        let payload = payload_for_index(cfg.message_bytes, index);

        tasks.push(tokio::spawn(async move {
            let _permit = permit;
            let started = Instant::now();
            let key = format!("rust-rdkafka-{index}");
            let record = FutureRecord::to(&topic).key(&key).payload(&payload);
            match producer.send(record, Timeout::After(Duration::from_secs(30))).await {
                Ok(_) => Ok(started.elapsed()),
                Err((err, _msg)) => Err((started.elapsed(), err.to_string())),
            }
        }));
    }

    let mut latencies_ms = Vec::with_capacity(cfg.messages);
    let mut error_count = 0usize;

    for task in tasks {
        match task.await? {
            Ok(latency) => latencies_ms.push(duration_ms(latency)),
            Err((latency, _)) => {
                latencies_ms.push(duration_ms(latency));
                error_count += 1;
            }
        }
    }

    let accepted = cfg.messages.saturating_sub(error_count);
    let elapsed = started_at.elapsed();
    let finished_wall = now_rfc3339_like();
    let p95 = percentile(&latencies_ms, 95.0);
    let throughput = round2(accepted as f64 / elapsed.as_secs_f64().max(0.001));
    let bytes_throughput = round2((accepted * cfg.message_bytes) as f64 / elapsed.as_secs_f64().max(0.001));

    let report = BenchmarkReport {
        schema_version: 2,
        run_id: cfg.run_id.clone(),
        scenario_name: cfg.scenario_name.clone(),
        scenario_tags: serde_json::json!({
            "client": cfg.client,
            "compression": cfg.compression,
            "concurrency": cfg.concurrency.to_string(),
            "lingerMs": cfg.linger_ms.to_string(),
            "messageBytes": cfg.message_bytes.to_string(),
            "messages": cfg.messages.to_string(),
        }),
        started_at: started_wall,
        finished_at: finished_wall,
        pass: error_count == 0,
        environment: serde_json::json!({
            "runtime": "rust",
            "kafka": cfg.brokers.join(","),
        }),
        request_path: serde_json::json!({
            "accepted": accepted,
            "errors": error_count,
            "p95LatencyMs": p95,
            "requestsPerSecond": throughput,
        }),
        failure: if error_count > 0 {
            Some(serde_json::json!({
                "stage": "publish",
                "message": format!("{error_count} publish operations returned errors."),
            }))
        } else {
            None
        },
        diagnostics: serde_json::json!({
            "assertions": [
                {
                    "key": "run.completed_successfully",
                    "label": "run completed successfully",
                    "pass": error_count == 0,
                    "severity": "error",
                    "message": format!("accepted={} errors={}", accepted, error_count),
                }
            ]
        }),
        measurements: vec![
            measurement(
                "produce_throughput",
                "produce throughput",
                "/s",
                throughput,
                "Acknowledged Kafka produce throughput across the benchmark window.",
                "accepted publishes / total benchmark seconds",
                "Higher is better when error count remains zero.",
            ),
            measurement(
                "producer_p95_latency",
                "producer p95 latency",
                "ms",
                p95,
                "95th percentile producer acknowledgement latency.",
                "95th percentile of per-message publish-to-ack latency",
                "Lower is better. Spikes indicate producer queueing, broker backpressure, or batching overhead.",
            ),
            measurement(
                "bytes_throughput",
                "bytes throughput",
                "B/s",
                bytes_throughput,
                "Acknowledged payload bytes per second.",
                "(accepted publishes * message bytes) / total benchmark seconds",
                "Useful to compare throughput when message size changes.",
            ),
            measurement(
                "errors",
                "errors",
                "",
                error_count as f64,
                "Publish operations that returned an error.",
                "count of produce callbacks / deliveries with err != nil",
                "Should remain at zero for valid throughput comparison.",
            ),
        ],
    };

    write_artifact(cfg, &report)
}

async fn ensure_topic(cfg: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let admin: AdminClient<DefaultClientContext> = ClientConfig::new()
        .set("bootstrap.servers", cfg.brokers.join(","))
        .create()?;

    let topic = topic_name(cfg);
    let new_topic = NewTopic::new(&topic, cfg.partitions, TopicReplication::Fixed(cfg.replication));
    let results = admin.create_topics(&[new_topic], &AdminOptions::new()).await?;
    for result in results {
        match result {
            Ok(_) => {}
            Err((_, err)) if err == rdkafka::types::RDKafkaErrorCode::TopicAlreadyExists => {}
            Err((name, err)) => return Err(format!("create topic {name}: {err:?}").into()),
        }
    }
    Ok(())
}

fn measurement(
    key: &str,
    label: &str,
    unit: &str,
    value: f64,
    definition: &str,
    calculation: &str,
    interpretation: &str,
) -> serde_json::Value {
    serde_json::json!({
        "key": key,
        "label": label,
        "unit": unit,
        "value": value,
        "definition": definition,
        "calculation": calculation,
        "interpretation": interpretation,
    })
}

fn write_artifact(cfg: &Config, report: &BenchmarkReport) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let directory = PathBuf::from(&cfg.results_dir).join(&cfg.scenario_name);
    fs::create_dir_all(&directory)?;
    let file_name = format!("{}_{}.json", timestamp_file_safe(), cfg.run_id);
    let target = directory.join(file_name);
    fs::write(&target, format!("{}\n", serde_json::to_string_pretty(report)?))?;
    Ok(target)
}

fn write_failure_artifact(cfg: &Config, started_at: &str, message: String) -> Result<(), Box<dyn std::error::Error>> {
    let report = BenchmarkReport {
        schema_version: 2,
        run_id: cfg.run_id.clone(),
        scenario_name: cfg.scenario_name.clone(),
        scenario_tags: serde_json::json!({ "client": cfg.client }),
        started_at: started_at.to_string(),
        finished_at: now_rfc3339_like(),
        pass: false,
        environment: serde_json::json!({
            "runtime": "rust",
            "kafka": cfg.brokers.join(","),
        }),
        request_path: serde_json::json!({
            "accepted": 0,
            "errors": 0,
            "p95LatencyMs": 0,
            "requestsPerSecond": 0,
        }),
        failure: Some(serde_json::json!({
            "stage": "benchmark",
            "message": message,
        })),
        diagnostics: serde_json::json!({
            "assertions": [
                {
                    "key": "run.completed_successfully",
                    "label": "run completed successfully",
                    "pass": false,
                    "severity": "error",
                    "message": message,
                }
            ]
        }),
        measurements: vec![],
    };
    let _ = write_artifact(cfg, &report)?;
    Ok(())
}

fn read_config() -> Config {
    let client = env_default("GO_KAFKA_BENCH_CLIENT", "rust-rdkafka");
    let run_id = env_default(
        "GO_KAFKA_BENCH_RUN_ID",
        &format!("go_kafka_raw_{}_{}", client.replace(|c: char| !c.is_ascii_alphanumeric(), "_"), timestamp_compact()),
    );
    Config {
        brokers: split_csv(&env_default(
            "GO_KAFKA_BENCH_BROKERS",
            &env_default("KAFKA_BROKERS", "localhost:19092"),
        )),
        client,
        compression: env_default("GO_KAFKA_BENCH_COMPRESSION", "none"),
        concurrency: env_usize("GO_KAFKA_BENCH_CONCURRENCY", 1024),
        linger_ms: env_u64("GO_KAFKA_BENCH_LINGER_MS", 5),
        message_bytes: env_usize("GO_KAFKA_BENCH_MESSAGE_BYTES", 1024),
        messages: env_usize("GO_KAFKA_BENCH_MESSAGES", 50000),
        partitions: env_i32("GO_KAFKA_BENCH_TOPIC_PARTITIONS", 12),
        replication: env_i32("GO_KAFKA_BENCH_TOPIC_REPLICATION", 1),
        results_dir: env_default("BENCHMARK_RESULTS_DIR", "benchmark-results"),
        run_id,
        scenario_name: env_default("BENCHMARK_SCENARIO_NAME", "go-kafka-producer-raw"),
        topic: env_default("GO_KAFKA_BENCH_TOPIC", ""),
        topic_prefix: env_default("GO_KAFKA_BENCH_TOPIC_PREFIX", "benchmark.go.kafka.client.raw"),
    }
}

fn topic_name(cfg: &Config) -> String {
    if !cfg.topic.is_empty() {
        return cfg.topic.clone();
    }
    format!("{}.{}", cfg.topic_prefix, cfg.client)
}

fn payload_for_index(size: usize, index: usize) -> Vec<u8> {
    let size = size.max(16);
    let prefix = format!("msg-{index:08}-");
    let mut body = vec![b'a'; size];
    body[..prefix.len().min(size)].copy_from_slice(&prefix.as_bytes()[..prefix.len().min(size)]);
    for (offset, byte) in body.iter_mut().enumerate().skip(prefix.len()) {
        *byte = b'a' + (offset % 26) as u8;
    }
    body
}

fn percentile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let idx = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    round2(sorted[idx.saturating_sub(1).min(sorted.len() - 1)])
}

fn duration_ms(value: Duration) -> f64 {
    round2(value.as_secs_f64() * 1000.0)
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn split_csv(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn env_default(name: &str, fallback: &str) -> String {
    env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| fallback.to_string())
}

fn env_usize(name: &str, fallback: usize) -> usize {
    env::var(name).ok().and_then(|v| v.parse::<usize>().ok()).filter(|v| *v > 0).unwrap_or(fallback)
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name).ok().and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0).unwrap_or(fallback)
}

fn env_i32(name: &str, fallback: i32) -> i32 {
    env::var(name).ok().and_then(|v| v.parse::<i32>().ok()).filter(|v| *v > 0).unwrap_or(fallback)
}

fn timestamp_compact() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
        .replace([':', '-'], "")
        .replace(".000000000", "")
}

fn timestamp_file_safe() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
        .replace(':', "-")
        .replace('.', "-")
}

fn now_rfc3339_like() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
