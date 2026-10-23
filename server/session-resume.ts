import WebSocket from "ws";

export interface SessionResumeRequest {
  type: "session:resume";
  payload: {
    token: string;
    [key: string]: unknown;
  };
}

export interface SessionResumeCallbacks<TPlayer> {
  /** Return the existing in-memory player/session for this token, or undefined. */
  findPlayerByToken: (token: string) => TPlayer | undefined;
  /** Make this new socket the active socket for the existing player. */
  attachSocket: (player: TPlayer, socket: WebSocket) => void;
  /** Send the latest room/game state and that player's private state to this socket. */
  sendCurrentState: (player: TPlayer, socket: WebSocket) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(value));
}

/**
 * Handle only `session:resume`; return true when the message was consumed.
 * Call this from your existing server message handler before normal game events.
 *
 * IMPORTANT: this restores a session only while the existing server's in-memory
 * game state still exists. A full server restart loses Map-based state unless
 * you separately persist it to a database or other durable storage.
 */
export function handleSessionResume<TPlayer>(
  socket: WebSocket,
  message: unknown,
  callbacks: SessionResumeCallbacks<TPlayer>,
): boolean {
  if (!isRecord(message) || message.type !== "session:resume") return false;

  const payload = isRecord(message.payload) ? message.payload : null;
  const token = payload && typeof payload.token === "string" ? payload.token : "";
  if (!token) {
    sendJson(socket, {
      type: "session:resume:failed",
      payload: { reason: "missing-token" },
    });
    return true;
  }

  const player = callbacks.findPlayerByToken(token);
  if (!player) {
    sendJson(socket, {
      type: "session:resume:failed",
      payload: { reason: "session-not-found" },
    });
    return true;
  }

  callbacks.attachSocket(player, socket);
  sendJson(socket, { type: "session:resumed", payload: { success: true } });
  callbacks.sendCurrentState(player, socket);
  return true;
}
