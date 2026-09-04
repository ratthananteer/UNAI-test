// SHARED UNAI REALTIME CLIENT
// One browser Socket.IO connection per place/building/floor.
// Reconnect is controlled here (Socket.IO's built-in reconnect is disabled) so
// transient disconnects do not create an uncontrolled connection storm.

type SocketLike = {
  connected?: boolean;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler?: (...args: any[]) => void) => void;
  emit: (event: string, ...args: any[]) => void;
  disconnect: () => void;
};

type SocketFactory = (url: string, options: Record<string, unknown>) => SocketLike;
type SocketIoWindow = Window & { io?: SocketFactory };
export type RealtimeStatusState = "connecting" | "connected" | "disconnected" | "error" | "rate_limited";

export type RealtimeStatus = {
  state: RealtimeStatusState;
  message: string;
  socketId?: string;
  error?: unknown;
  reason?: unknown;
};

export type RealtimeTagEvent = {
  payload: unknown;
  eventName: string;
};

export type RealtimeSubscriptionOptions = {
  placeId: string | number;
  buildingId: string | number;
  floorId: string | number;
  onStatus?: (status: RealtimeStatus) => void;
  onTag?: (event: RealtimeTagEvent) => void;
};

type RealtimeSubscriber = (payload: unknown) => void;

type Connection = {
  key: string;
  placeId: string | number;
  buildingId: string | number;
  floorId: string | number;
  socket: SocketLike;
  listeners: Set<RealtimeSubscriber>;
  reconnectTimer: number | null;
  reconnectAttempt: number;
  watchdogTimer: number | null;
  reconnecting: boolean;
  closed: boolean;
};

const SOCKET_URL = "https://socket.lailab.online";
const SOCKET_PATH = "/ble/location";
const SOCKET_IO_CDN = "https://cdn.socket.io/4.8.1/socket.io.min.js";
const SOCKET_WATCHDOG_MS = 10_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 750;
const MAX_RECONNECT_ATTEMPTS = 8;
const TOKEN_CACHE_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const DISCONNECT_GRACE_MS = 2_000;

let socketIoPromise: Promise<SocketFactory> | null = null;
let connection: Connection | null = null;
let connectionPromise: Promise<void> | null = null;
let connectionPromiseKey = "";
let reconnectPromise: Promise<void> | null = null;
let reconnectingKey = "";
let disconnectTimer: number | null = null;
let rateLimitedUntil = 0;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const tokenPromises = new Map<string, Promise<string>>();

function keyOf(placeId: string | number, buildingId: string | number, floorId: string | number) {
  return `${String(placeId)}:${String(buildingId)}:${String(floorId)}`;
}

function reconnectDelay(attempt: number) {
  const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return exponential + Math.floor(Math.random() * RECONNECT_JITTER_MS);
}

function isRateLimit(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /too many connection attempts|rate.?limit|429/i.test(message);
}

function isUnauthorized(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /401|403|unauthorized|forbidden|invalid.*token|token.*invalid|token.*expired/i.test(message);
}

function stopTimers(target: Connection) {
  if (target.reconnectTimer !== null) {
    window.clearTimeout(target.reconnectTimer);
    target.reconnectTimer = null;
  }
  if (target.watchdogTimer !== null) {
    window.clearInterval(target.watchdogTimer);
    target.watchdogTimer = null;
  }
}

function closeConnection(target: Connection) {
  target.closed = true;
  stopTimers(target);
  target.socket.disconnect();
  if (connection === target) connection = null;
}

async function loadSocketIo(): Promise<SocketFactory> {
  if (typeof window === "undefined") throw new Error("UNAI realtime is browser-only.");

  const current = (window as SocketIoWindow).io;
  if (current) return current;
  if (socketIoPromise) return socketIoPromise;

  socketIoPromise = new Promise<SocketFactory>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SOCKET_IO_CDN}"]`);
    if (existing) {
      existing.addEventListener("load", () => {
        const io = (window as SocketIoWindow).io;
        if (io) resolve(io);
        else reject(new Error("Socket.IO loaded but window.io is unavailable."));
      }, { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load Socket.IO client.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = SOCKET_IO_CDN;
    script.async = true;
    script.onload = () => {
      const io = (window as SocketIoWindow).io;
      if (io) resolve(io);
      else reject(new Error("Socket.IO loaded but window.io is unavailable."));
    };
    script.onerror = () => reject(new Error("Could not load Socket.IO client."));
    document.head.appendChild(script);
  }).catch((error) => {
    socketIoPromise = null;
    throw error;
  });

  return socketIoPromise;
}

async function getSocketToken(floorId: string | number, forceRefresh = false): Promise<string> {
  const key = String(floorId);
  const cached = tokenCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;

  const existing = tokenPromises.get(key);
  if (existing && !forceRefresh) return existing;

  const request = fetch(`/api/socket-topic?floorID=${encodeURIComponent(key)}`, {
    method: "GET",
    cache: "no-store",
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data?.error || data?.message || `Failed to get socket topic: HTTP ${response.status}`);
        if (response.status === 429) {
          rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        }
        throw error;
      }
      const token = data?.socket_token ?? data?.socketToken ?? data?.token;
      if (!token) throw new Error("Socket topic response did not contain socket_token.");
      tokenCache.set(key, { token: String(token), expiresAt: Date.now() + TOKEN_CACHE_MS });
      return String(token);
    })
    .finally(() => tokenPromises.delete(key));

  tokenPromises.set(key, request);
  return request;
}

function notify(target: Connection, payload: unknown) {
  for (const listener of Array.from(target.listeners)) {
    try {
      listener(payload);
    } catch (error) {
      console.error("[UNAI REALTIME] Subscriber error:", error);
    }
  }
}

function joinRooms(target: Connection) {
  const baseTopic = `${target.placeId}/${target.buildingId}/${target.floorId}`;
  target.socket.emit("join_room", `${baseTopic}/tag`);
  target.socket.emit("join_room", `${baseTopic}/anchor`);
  target.socket.emit("join_room", `${baseTopic}/alert`);
  target.socket.emit("/broadcastToRoom", {
    room: "init_unai_location",
    data: { action: "get_init_unai_location", get_topic: baseTopic },
  });
}

function scheduleReconnect(target: Connection, reason: string) {
  if (target.closed || connection !== target || target.listeners.size === 0) return;
  if (target.socket.connected || target.reconnectTimer !== null || target.reconnecting) return;

  const now = Date.now();
  if (rateLimitedUntil > now) {
    target.reconnectTimer = window.setTimeout(() => {
      target.reconnectTimer = null;
      scheduleReconnect(target, "Rate-limit cooldown finished.");
    }, rateLimitedUntil - now);
    return;
  }

  if (target.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[UNAI REALTIME] Reconnect paused after ${MAX_RECONNECT_ATTEMPTS} attempts.`);
    return;
  }

  target.reconnectAttempt += 1;
  const delay = reconnectDelay(target.reconnectAttempt);
  console.warn(`[UNAI REALTIME] ${reason} Reconnecting in ${delay}ms (attempt ${target.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}).`);

  target.reconnectTimer = window.setTimeout(() => {
    target.reconnectTimer = null;
    if (target.closed || connection !== target || target.listeners.size === 0) return;
    if (reconnectPromise && reconnectingKey === target.key) return;

    reconnectingKey = target.key;
    reconnectPromise = reconnectConnection(target)
      .catch((error) => {
        if (!target.closed && connection === target && target.listeners.size > 0) {
          if (isRateLimit(error)) rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
          scheduleReconnect(target, `Reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      .finally(() => {
        if (reconnectingKey === target.key) {
          reconnectingKey = "";
          reconnectPromise = null;
        }
      });
  }, delay);
}

function attachHandlers(target: Connection) {
  const socket = target.socket;

  socket.on("connect", () => {
    if (connection !== target || target.closed) return;
    target.reconnectAttempt = 0;
    target.reconnecting = false;
    rateLimitedUntil = 0;
    if (target.reconnectTimer !== null) {
      window.clearTimeout(target.reconnectTimer);
      target.reconnectTimer = null;
    }
    console.info(`[UNAI REALTIME] Connected floor=${String(target.floorId)}`);
    notify(target, {
      type: "status",
      state: "connected",
      message: `Connected to UNAI realtime floor ${String(target.floorId)}.`,
      socketId: undefined,
    });
    joinRooms(target);
  });

  socket.on("connect_error", (error: unknown) => {
    if (connection !== target || target.closed) return;
    if (isRateLimit(error)) rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
    if (isUnauthorized(error)) tokenCache.delete(String(target.floorId));
    notify(target, {
      type: "status",
      state: isRateLimit(error) ? "rate_limited" : "error",
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    socket.disconnect();
    scheduleReconnect(target, "Socket connection error.");
  });

  socket.on("disconnect", (reason: unknown) => {
    if (connection !== target || target.closed) return;
    notify(target, {
      type: "status",
      state: "disconnected",
      message: `Socket disconnected (${String(reason)}). Reconnecting automatically.`,
      reason,
    });
    if (target.listeners.size > 0) scheduleReconnect(target, `Socket disconnected (${String(reason)}).`);
  });

  // Keep the existing event fan-out model: all server payloads are forwarded to
  // the component subscriber, which already owns payload parsing/filtering.
  socket.on("message", (payload: unknown) => {
    if (connection === target && !target.closed) {
      notify(target, { type: "tag", payload, eventName: "message" });
    }
  });

  for (const event of ["/broadcastToRoom", "tag", "anchor", "alert", "location"]) {
    socket.on(event, (payload: unknown) => {
      if (connection === target && !target.closed) {
        notify(target, { type: "tag", payload, eventName: event });
      }
    });
  }
}

async function createConnection(
  placeId: string | number,
  buildingId: string | number,
  floorId: string | number,
  listeners: Set<RealtimeSubscriber>,
  reconnectAttempt = 0,
): Promise<Connection> {
  const [SocketIO, socketToken] = await Promise.all([loadSocketIo(), getSocketToken(floorId)]);

  const socket = SocketIO(SOCKET_URL, {
    path: SOCKET_PATH,
    query: { token: socketToken },
    transports: ["websocket"],
    reconnection: false,
    forceNew: false,
    timeout: 10_000,
  });

  const target: Connection = {
    key: keyOf(placeId, buildingId, floorId),
    placeId,
    buildingId,
    floorId,
    socket,
    listeners,
    reconnectTimer: null,
    reconnectAttempt,
    watchdogTimer: null,
    reconnecting: false,
    closed: false,
  };

  connection = target;
  attachHandlers(target);

  target.watchdogTimer = window.setInterval(() => {
    if (target.closed || connection !== target || target.listeners.size === 0) return;
    if (!target.socket.connected) scheduleReconnect(target, "Socket watchdog detected disconnected state.");
  }, SOCKET_WATCHDOG_MS);

  return target;
}

async function reconnectConnection(target: Connection): Promise<void> {
  if (target.closed || connection !== target || target.listeners.size === 0 || target.reconnecting) return;
  target.reconnecting = true;
  stopTimers(target);

  const previousSocket = target.socket;
  const listeners = target.listeners;
  const { placeId, buildingId, floorId, key } = target;
  previousSocket.disconnect();
  if (connection === target) connection = null;

  try {
    let next: Connection;
    try {
      next = await createConnection(placeId, buildingId, floorId, listeners, target.reconnectAttempt);
    } catch (firstError) {
      if (!isUnauthorized(firstError)) throw firstError;
      tokenCache.delete(String(floorId));
      next = await createConnection(placeId, buildingId, floorId, listeners, target.reconnectAttempt);
    }
    if (next.key !== key || listeners.size === 0) {
      closeConnection(next);
      return;
    }
  } catch (error) {
    // createConnection temporarily clears the global connection while it
    // obtains the socket token. Restore the old connection object on failure
    // so scheduleReconnect() can queue the next backoff attempt instead of
    // silently losing the reconnect loop.
    if (!target.closed && listeners.size > 0) {
      target.socket = previousSocket;
      connection = target;
    }
    throw error;
  } finally {
    target.reconnecting = false;
  }
}

async function ensureConnection(
  placeId: string | number,
  buildingId: string | number,
  floorId: string | number,
  listeners: Set<RealtimeSubscriber>,
) {
  const key = keyOf(placeId, buildingId, floorId);

  if (disconnectTimer !== null) {
    window.clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }

  if (connection?.key === key && !connection.closed && connection.socket.connected) return;
  if (reconnectPromise && reconnectingKey === key) {
    await reconnectPromise;
    return;
  }
  if (connectionPromise && connectionPromiseKey === key) {
    await connectionPromise;
    return;
  }
  if (connection && connection.key !== key) closeConnection(connection);

  connectionPromiseKey = key;
  connectionPromise = createConnection(placeId, buildingId, floorId, listeners)
    .then(() => undefined)
    .finally(() => {
      connectionPromise = null;
      connectionPromiseKey = "";
    });
  await connectionPromise;
}

function scheduleClose(target: Connection) {
  if (disconnectTimer !== null) window.clearTimeout(disconnectTimer);
  disconnectTimer = window.setTimeout(() => {
    disconnectTimer = null;
    if (target.listeners.size === 0 && connection === target) closeConnection(target);
  }, DISCONNECT_GRACE_MS);
}

export async function subscribeUnaiRealtime(
  options: RealtimeSubscriptionOptions,
): Promise<() => void> {
  if (typeof window === "undefined") throw new Error("UNAI realtime is browser-only.");

  const { placeId, buildingId, floorId, onStatus, onTag } = options;
  const listener: RealtimeSubscriber = (event: unknown) => {
    if (!event || typeof event !== "object") return;
    const value = event as Record<string, unknown>;

    if (value.type === "status") {
      onStatus?.({
        state: String(value.state ?? "error") as RealtimeStatusState,
        message: String(value.message ?? "UNAI realtime status changed."),
        socketId: typeof value.socketId === "string" ? value.socketId : undefined,
        error: value.error,
        reason: value.reason,
      });
      return;
    }

    if (value.type === "tag") {
      onTag?.({
        payload: value.payload,
        eventName: String(value.eventName ?? "message"),
      });
    }
  };

  const listeners = connection?.listeners ?? new Set<RealtimeSubscriber>();
  listeners.add(listener);
  onStatus?.({ state: "connecting", message: `Connecting to UNAI realtime floor ${String(floorId)}...` });

  try {
    await ensureConnection(placeId, buildingId, floorId, listeners);
  } catch (error) {
    listeners.delete(listener);
    onStatus?.({
      state: "error",
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && connection) scheduleClose(connection);
  };
}

export function getUnaiRealtimeStatus() {
  return {
    connected: Boolean(connection?.socket.connected),
    floorId: connection?.floorId ?? null,
    subscriberCount: connection?.listeners.size ?? 0,
    reconnectAttempt: connection?.reconnectAttempt ?? 0,
    rateLimited: Date.now() < rateLimitedUntil,
  };
}
