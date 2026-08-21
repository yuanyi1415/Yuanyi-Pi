import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";
import { gatewayEnabled, gatewayListSessions, legacyRuntimeEnabled, runtimeUnavailableResponse } from "@/lib/personal-gateway";

export const dynamic = "force-dynamic";
const encoder = new TextEncoder();

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes an update whenever any session starts or stops working,
// so the sidebar never has to poll.
export async function GET(req: Request) {
  if (gatewayEnabled()) return gatewayRunningEvents(req);
  if (!legacyRuntimeEnabled()) return runtimeUnavailableResponse();
  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const unsubscribe = subscribeRunningSessions((ids) => {
        try {
          encode({ type: "running", runningSessionIds: ids });
        } catch {
          // controller already closed
        }
      });

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client just sets the same set.)
      encode({ type: "running", runningSessionIds: getRunningRpcSessionIds() });

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function gatewayRunningEvents(req: Request): Response {
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const encode = (data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const poll = async () => {
        try {
          const { sessions } = await gatewayListSessions();
          encode({ type: "running", runningSessionIds: sessions.filter((session) => session.running).map((session) => session.sessionId) });
        } catch {
          // Retry on the next poll while the Gateway is unavailable.
        }
      };
      void poll();
      const timer = setInterval(() => void poll(), 2500);
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(":\n\n"));
      }, 30000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
