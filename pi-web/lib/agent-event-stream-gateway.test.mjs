import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createGatewayEventStream } = await jiti.import("./agent-event-stream-gateway.ts");

test("Gateway SSE 连接先透传真实 streaming 状态和消息快照", async () => {
  const controller = new AbortController();
  const gatewayBody = new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode(
        `retry: 3000\n\ndata: ${JSON.stringify({
          type: "state",
          payload: { isStreaming: true, streamingMessage: { role: "assistant", content: [] } },
        })}\n\n`,
      ));
      stream.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({
          type: "message_start",
          timestamp: 123,
          requestId: "request-1",
          payload: { type: "message_start", message: { role: "assistant", content: [] } },
        })}\n\n`,
      ));
      stream.close();
    },
  });
  const stream = createGatewayEventStream(
    new Request("http://localhost/events", { signal: controller.signal }),
    "session-1",
    async () => new Response(gatewayBody),
  );
  const response = new Response(stream);
  const body = await response.text();
  const frames = body.split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)));
  assert.deepEqual(frames[0], { type: "connected", sessionId: "session-1", isStreaming: true });
  assert.deepEqual(frames[1], { type: "message_start", message: { role: "assistant", content: [] } });
  assert.deepEqual(frames[2], {
    type: "message_start",
    message: { role: "assistant", content: [] },
    requestId: "request-1",
    gatewayEventAt: 123,
  });
  controller.abort();
});
