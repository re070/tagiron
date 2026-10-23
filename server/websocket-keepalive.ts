import WebSocket, { type RawData } from "ws";

export interface WebSocketKeepaliveOptions {
  /** Native WebSocket ping interval; default 30 seconds. */
  pingIntervalMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Attach keepalive handling to each accepted `ws` connection.
 *
 * The application-level `ping`/`pong` messages keep a Render free Web Service
 * from being considered idle while game clients are active. Native protocol
 * ping/pong frames help the server detect half-open/stale clients.
 *
 * Usage inside your existing wss.on("connection", socket => { ... }):
 *   attachWebSocketKeepalive(socket);
 * Keep your current game message handler too. In its switch statement, ignore
 * `ping`/`pong` so game logic does not treat them as gameplay actions.
 */
export function attachWebSocketKeepalive(
  socket: WebSocket,
  options: WebSocketKeepaliveOptions = {},
): () => void {
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  let alive = true;
  let cleanedUp = false;

  const onPong = (): void => {
    alive = true;
  };

  const onMessage = (raw: RawData): void => {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString()) as unknown;
    } catch {
      return;
    }

    if (!isRecord(message) || message.type !== "ping") return;
    if (socket.readyState !== WebSocket.OPEN) return;

    try {
      socket.send(JSON.stringify({ type: "pong", payload: { serverTime: Date.now() } }));
    } catch {
      // The regular close/error handler and the health interval handle failures.
    }
  };

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(interval);
    socket.off("pong", onPong);
    socket.off("message", onMessage);
    socket.off("close", cleanup);
    socket.off("error", cleanup);
  };

  socket.on("pong", onPong);
  socket.on("message", onMessage);
  socket.on("close", cleanup);
  socket.on("error", cleanup);

  const interval = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      cleanup();
      return;
    }

    if (!alive) {
      cleanup();
      socket.terminate();
      return;
    }

    alive = false;
    try {
      socket.ping();
    } catch {
      cleanup();
      socket.terminate();
    }
  }, pingIntervalMs);
  interval.unref();

  return cleanup;
}
