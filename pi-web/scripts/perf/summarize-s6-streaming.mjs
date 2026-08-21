import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarize(samples) {
  const metrics = [
    ["Ingress", "t0", "t1"],
    ["Model TTFT", "t1", "t2"],
    ["Stream Proxy", "t2", "t3"],
  ];
  return metrics.map(([label, start, end]) => {
    const values = samples
      .map((sample) => Number(sample[end]) - Number(sample[start]))
      .filter(Number.isFinite);
    return {
      label,
      samples: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: node scripts/perf/summarize-s6-streaming.mjs samples.jsonl");
    process.exit(1);
  }
  const samples = readFileSync(input, "utf8").split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  console.log(`Samples: ${samples.length}`);
  for (const metric of summarize(samples)) {
    console.log(`${metric.label}: samples=${metric.samples} P50=${metric.p50 ?? "n/a"}ms P95=${metric.p95 ?? "n/a"}ms`);
  }
}
