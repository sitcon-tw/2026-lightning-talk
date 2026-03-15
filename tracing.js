"use strict";

const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");

const OTEL_ENABLED = process.env.OTEL_ENABLED !== "false";

if (!OTEL_ENABLED) {
	console.log("[OTEL] Tracing disabled (OTEL_ENABLED=false)");
	module.exports = { sdk: null };
	return;
}

const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "http://localhost:10428/insert/opentelemetry/v1/traces";
const serviceName = process.env.OTEL_SERVICE_NAME || "2026-lightning-talk";

const traceExporter = new OTLPTraceExporter({
	url: endpoint,
	headers: {}
});

const sdk = new NodeSDK({
	resource: resourceFromAttributes({
		[ATTR_SERVICE_NAME]: serviceName,
		[ATTR_SERVICE_VERSION]: "1.0.0"
	}),
	traceExporter,
	instrumentations: [
		getNodeAutoInstrumentations({
			// Disable noisy fs instrumentation
			"@opentelemetry/instrumentation-fs": { enabled: false }
		})
	]
});

sdk.start();
console.log(`[OTEL] Tracing started — exporting to ${endpoint}`);

process.on("SIGTERM", () => {
	sdk
		.shutdown()
		.then(() => console.log("[OTEL] SDK shut down successfully"))
		.catch(err => console.error("[OTEL] Error shutting down SDK", err))
		.finally(() => process.exit(0));
});

module.exports = { sdk };
