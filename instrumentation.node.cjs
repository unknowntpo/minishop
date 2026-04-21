const { NodeSDK } = require("@opentelemetry/sdk-node");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");

const enabled = ["1", "true", "yes"].includes(String(process.env.OTEL_ENABLED || "").toLowerCase());

if (enabled) {
  const serviceName = process.env.OTEL_SERVICE_NAME || process.env.HOSTNAME || "minishop-node";
  const endpointBase = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://tempo:4318").replace(/\/$/, "");
  const traceExporter = new OTLPTraceExporter({
    url: `${endpointBase}/v1/traces`,
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": serviceName,
      "service.namespace": "minishop",
      "deployment.environment": process.env.NODE_ENV || "development",
    }),
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": {
          enabled: false,
        },
      }),
    ],
  });

  sdk.start();

  const shutdown = async () => {
    try {
      await sdk.shutdown();
    } catch (error) {
      console.error("otel_shutdown_failed", error);
    }
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
