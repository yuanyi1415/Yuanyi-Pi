import assert from "node:assert/strict";
import test from "node:test";
import { percentile, summarize } from "./summarize-s6-streaming.mjs";

test("summarize-s6-streaming computes P50/P95 from epoch samples", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  const metrics = summarize([
    { t0: 0, t1: 2, t2: 5, t3: 9 },
    { t0: 10, t1: 13, t2: 17, t3: 23 },
  ]);
  assert.deepEqual(metrics, [
    { label: "Ingress", samples: 2, p50: 2, p95: 3 },
    { label: "Model TTFT", samples: 2, p50: 3, p95: 4 },
    { label: "Stream Proxy", samples: 2, p50: 4, p95: 6 },
  ]);
});
