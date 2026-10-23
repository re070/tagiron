/**
 * Resilient browser WebSocket client for Tagiron.
 *
 * - Local development defaults to ws://<current-host>:3001 (works with localhost and LAN IPs).
 * - Production can set NEXT_PUBLIC_WS_URL to the externally reachable WebSocket URL.
 * - Sends an application-level ping so Render sees inbound WebSocket traffic.
 * - Reconnects with exponential backoff and jitter.
 * - Resends a saved `session:resume` payload after every connection opens.
 * - Does not queue gameplay actions while disconnected (avoids stale actions firing later).
 */

export type TagironConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export type JsonRecord = Record<string, unknown>;

export interface TagironWebSocketClientOptions {
  url?: string;
  heartbeatIntervalMs?: number;
  staleConnectionTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  resumeStorageKey?: string;
  onMessage?: (message: unknown) => void;
  onStatusChange?: (status: TagironConnectionStatus) => void;
  onError?: (error: Event) => void;
}

const DEFAULT_RESUME_STORAGE_KEY = "tagiron:resume-payload:v1";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * NEXT_PUBLIC_WS_URL takes precedence.
 * In development, use port 3001 on the same host as the page, so localhost and
 * local-network/hotspot addresses work without editing the source each time.
 * In production, use same-origin WebSocket unless NEXT_PUBLIC_WS_URL is set.
 * If the production WebSocket server is a separate service, set that variable.
 */
export function resolveTagironWebSocketUrl(): string {
  const configuredUrl = process.env.NEXT_PUBLIC_WS_URL?.trim();
  if (configuredUrl) return configuredUrl;

  if (typeof window === "undefined") {
    throw new Error(
      "WebSocket URL can only be resolved in the browser. Pass options.url when using a non-browser runtime.",
    );
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const hostname = window.location.hostname;

  if (process.env.NODE_ENV !== "production") {
    const configuredPort = process.env.NEXT_PUBLIC_WS_PORT?.trim();
    const port = configuredPort && /^\d+$/.test(configuredPort) ? configuredPort : "3001";
    return `${protocol}//${hostname}:${port}`;
  }

  return `${protocol}//${window.location.host}`;
}

export class TagironWebSocketClient {
  private readonly url: string;
  private readonly heartbeatIntervalMs: number;
  private readonly staleConnectionTimeoutMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectJitterRatio: number;
  private readonly resumeStorageKey: string;
  private readonly onMessage?: (message: unknown) => void;
  private readonly onStatusChange?: (status: TagironConnectionStatus) => void;
  private readonly onError?: (error: Event) => void;

  private socket: WebSocket | null = null;
  private status: TagironConnectionStatus = "idle";
  private manuallyClosed = false;
  private hasConnectedOnce = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;

  constructor(options: TagironWebSocketClientOptions = {}) {
    this.url = options.url ?? resolveTagironWebSocketUrl();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.staleConnectionTimeoutMs = options.staleConnectionTimeoutMs ?? 75_000;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.reconnectJitterRatio = options.reconnectJitterRatio ?? 0.2;
    this.resumeStorageKey = options.resumeStorageKey ?? DEFAULT_RESUME_STORAGE_KEY;
    this.onMessage = options.onMessage;
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
  }

  get currentStatus(): TagironConnectionStatus {
    return this.status;
  }

  get currentUrl(): string {
    return this.url;
  }

  connect(): void {
    if (this.manuallyClosed) this.manuallyClosed = false;
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.openSocket(this.hasConnectedOnce);
  }

  /** Send a message only when connected. Messages are deliberately not queued. */
  send(type: string, payload: unknown = {}): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify({ type, payload }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save the exact payload expected by your server's `session:resume` handler.
   * Example: client.setResumePayload({ token: sessionToken, roomId });
   * Call this after room creation/join succeeds; clear it when the player leaves.
   */
  setResumePayload(payload: JsonRecord | null): void {
    if (typeof window === "undefined") return;
    try {
      if (payload === null) {
        window.sessionStorage.removeItem(this.resumeStorageKey);
      } else {
        window.sessionStorage.setItem(this.resumeStorageKey, JSON.stringify(payload));
      }
    } catch {
      // Storage can be disabled by browser privacy settings. Reconnection still works,
      // but a session resume payload cannot survive a page reload in that case.
    }
  }

  clearResumePayload(): void {
    this.setResumePayload(null);
  }

  /** Send the saved resume request immediately, if connected. */
  resumeNow(): boolean {
    const payload = this.readResumePayload();
    return payload === null ? false : this.send("session:resume", payload);
  }

  close(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close(1000, "Client closed connection");
      } catch {
        // The browser may already have closed the socket.
      }
    }
    this.setStatus("closed");
  }

  private openSocket(isReconnect: boolean): void {
    if (this.manuallyClosed) return;
    this.setStatus(isReconnect ? "reconnecting" : "connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.manuallyClosed) return;
      this.hasConnectedOnce = true;
      this.lastPongAt = Date.now();
      this.setStatus("connected");
      this.startHeartbeat(socket);

      // Resume only if the app previously stored a session payload.
      const resumePayload = this.readResumePayload();
      if (resumePayload !== null) {
        this.send("session:resume", resumePayload);
      }
    });

    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (this.socket !== socket) return;
      const parsed = this.parseMessage(event.data);
      if (isRecord(parsed) && parsed.type === "pong") {
        this.lastPongAt = Date.now();
        // Reset exponential backoff only after the new connection proves stable enough
        // to exchange an application heartbeat, rather than on every short-lived open.
        this.reconnectAttempts = 0;
        return;
      }
      this.onMessage?.(parsed);
    });

    socket.addEventListener("error", (event) => {
      if (this.socket === socket) this.onError?.(event);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearHeartbeatTimer();
      if (this.manuallyClosed) {
        this.setStatus("closed");
      } else {
        this.scheduleReconnect();
      }
    });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.manuallyClosed) return;

      if (Date.now() - this.lastPongAt > this.staleConnectionTimeoutMs) {
        // Force the old socket out of the current slot before retrying. This also
        // handles half-open connections where a close event is delayed indefinitely.
        this.socket = null;
        this.clearHeartbeatTimer();
        try {
          socket.close(4000, "Heartbeat timeout");
        } catch {
          // Ignore and proceed to reconnect.
        }
        this.scheduleReconnect();
        return;
      }

      // Browser WebSocket APIs cannot send protocol-level ping frames, so use a
      // small JSON message. The server helper responds with { type: "pong" }.
      try {
        socket.send(JSON.stringify({ type: "ping", payload: { clientTime: Date.now() } }));
      } catch {
        // The close/error handlers will handle the reconnect.
      }
    }, this.heartbeatIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer) return;
    this.setStatus("reconnecting");

    const baseDelay = Math.min(
      this.reconnectInitialDelayMs * 2 ** this.reconnectAttempts,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempts += 1;
    const jitter = 1 + (Math.random() * 2 - 1) * this.reconnectJitterRatio;
    const delay = Math.max(250, Math.round(baseDelay * jitter));

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket(true);
    }, delay);
  }

  private readResumePayload(): JsonRecord | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem(this.resumeStorageKey);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private parseMessage(data: unknown): unknown {
    if (typeof data !== "string") return data;
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return data;
    }
  }

  private setStatus(nextStatus: TagironConnectionStatus): void {
    if (this.status === nextStatus) return;
    this.status = nextStatus;
    this.onStatusChange?.(nextStatus);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
