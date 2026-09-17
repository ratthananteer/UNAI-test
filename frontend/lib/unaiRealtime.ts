"use client";

export type RealtimeTagPayload = {
  payload: unknown;
  eventName: string;
};

type Listener = (event: RealtimeTagPayload) => void;

type SocketLike = {
  id?: string;
  connected?: boolean;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler?: (...args: any[]) => void) => void;
  emit: (event: string, ...args: any[]) => void;
  disconnect: () => void;
};

type Connection = {
  key: string;
  placeId: string | number;
  buildingId: string | number;
  floorId: string | number;
  socket: SocketLike;
  listeners: Set<Listener>;
  reconnectTimer: number | null;
  reconnectAttempt: number;
  watchdogTimer: number | null;
  reconnecting: boolean;
  closed: boolean;
};

type TokenCacheEntry = {
  token: string;
  expiresAt: number;
};

let connection: Connection | null = null;
let connectionPromise: Promise<Connection | null> | null = null;
let pendingKey = "";
let pendingListeners = new Set<Listener>();
let pendingStatusListeners = new Set<(status: { state: string; message: string; socketId?: string }) => void>();

const tokenPromises = new Map<string, Promise<string>>();
const tokenCache = new Map<string, TokenCacheEntry>();

let disconnectTimer: number | null = null;
let rateLimitedUntil = 0;
let ioPromise: Promise<any> | null = null;
let reconnectPromise: Promise<void> | null = null;
let reconnectingKey = "";

const GRACE_MS = 2_000;
const TOKEN_CACHE_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

// Socket.IO automatic reconnection is intentionally disabled. We own the
// reconnect policy here so one shared socket can recover without creating a
// burst of connections when the network/server is unstable.
const SOCKET_WATCHDOG_MS = 10_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 750;
const MAX_RECONNECT_ATTEMPTS = 8;

function reconnectDelay(attempt: number): number {
  const exponential = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return exponential + Math.floor(Math.random() * RECONNECT_JITTER_MS);
}

function report(status: { state: string; message: string; socketId?: string }) {
  pendingStatusListeners.forEach((listener) => listener(status));
  connection?.listeners.forEach(() => {
    // Status is delivered through the subscriber-specific callback below.
  });
}

function loadIo(): Promise<any> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Socket.IO requires a browser"));
  }

  if (typeof (window as any).io === "function") {
    return Promise.resolve((window as any).io);
  }

  if (ioPromise) return ioPromise;

  ioPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-unai-socket-io]"
    );

    if (existing) {
      existing.addEventListener("load", () => resolve((window as any).io));
      existing.addEventListener("error", () =>
        reject(new Error("Could not load Socket.IO client"))
      );
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.socket.io/4.8.1/socket.io.min.js";
    script.async = true;
    script.dataset.unaiSocketIo = "true";
    script.onload = () =>
      typeof (window as any).io === "function"
        ? resolve((window as any).io)
        : reject(new Error("Socket.IO client loaded without window.io"));
    script.onerror = () =>
      reject(new Error("Could not load Socket.IO client"));
    document.head.appendChild(script);
  }).catch((error) => {
    ioPromise = null;
    throw error;
  });

  return ioPromise;
}

function isRateLimit(error: unknown) {
  return /too many connection attempts|rate.?limit|connection.*limit/i.test(
    String((error as any)?.message || error)
  );
}

// UNAI realtime payloads can contain usage_type directly. Filter ASSET here,
// at the single shared Socket.IO boundary, before any page receives/logs the
// payload. This is intentionally independent of the HTTP /api/tag endpoint.
function isAssetRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const usageType =
    item.usage_type ??
    item.usageType ??
    (item.usage && typeof item.usage === "object"
      ? (item.usage as Record<string, unknown>).type
      : undefined);
  return String(usageType ?? "").trim().toUpperCase() === "ASSET";
}

function filterAssetPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isAssetRecord(item))
      .map(filterAssetPayload);
  }

  if (!value || typeof value !== "object") return value;
  if (isAssetRecord(value)) return undefined;

  const object = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    if (child && typeof child === "object") {
      const filtered = filterAssetPayload(child);
      if (filtered !== undefined) result[key] = filtered;
    } else {
      result[key] = child;
    }
  }
  return result;
}

function containsAssetRecord(value: unknown): boolean {
  if (isAssetRecord(value)) return true;
  if (Array.isArray(value)) return value.some(containsAssetRecord);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsAssetRecord);
}

async function getToken(
  key: string,
  floorId: string | number
): Promise<string> {
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const existingPromise = tokenPromises.get(key);
  if (existingPromise) return existingPromise;

  const tokenPromise = fetch(`/api/socket-topic?floorID=${encodeURIComponent(String(floorId))}`, {
      method: "GET",
      cache: "no-store",
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data?.error || `HTTP ${response.status}`);
        }

        const token = data?.socket_token;
        if (!token) {
          throw new Error("Socket API did not return socket_token");
        }

        const value = String(token);
        tokenCache.set(key, {
          token: value,
          expiresAt: Date.now() + TOKEN_CACHE_MS,
        });
        return value;
      })
      .catch((error) => {
        throw error;
      });

  tokenPromises.set(key, tokenPromise);
  void tokenPromise.then(
    () => tokenPromises.delete(key),
    () => tokenPromises.delete(key),
  );

  return tokenPromise;
}

function stopConnectionTimers(target: Connection) {
  if (target.reconnectTimer !== null) {
    window.clearTimeout(target.reconnectTimer);
    target.reconnectTimer = null;
  }
  if (target.watchdogTimer !== null) {
    window.clearInterval(target.watchdogTimer);
    target.watchdogTimer = null;
  }
}

function closeConnection() {
  if (!connection) return;

  const old = connection;
  old.closed = true;
  stopConnectionTimers(old);
  connection = null;

  old.socket.off("tag");
  old.socket.off("clientBox");
  old.socket.off("sensor");
  old.socket.off("message");
  old.socket.off("connect");
  old.socket.off("disconnect");
  old.socket.off("connect_error");
  old.socket.disconnect();
}

function clearDisconnectTimer() {
  if (disconnectTimer !== null) {
    window.clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
}

async function createConnection(
  key: string,
  placeId: string | number,
  buildingId: string | number,
  floorId: string | number,
  reconnectAttempt = 0
): Promise<Connection | null> {
  if (Date.now() < rateLimitedUntil) {
    const seconds = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    report({
      state: "rate_limited",
      message: `UNAI is rate-limiting connections. Waiting ${seconds}s.`,
    });
    return null;
  }

  try {
    report({
      state: "connecting",
      message: "Getting socket token...",
    });

    const socketToken = await getToken(key, floorId);

    // All subscribers may have disappeared while the token was loading.
    if (pendingKey !== key || pendingListeners.size === 0) {
      return null;
    }

    const io = await loadIo();

    if (pendingKey !== key || pendingListeners.size === 0) {
      return null;
    }

    // A different subscriber may have created the connection while we were
    // loading the client/token. Reuse it instead of opening another socket.
    if (connection?.key === key) {
      connection.listeners = new Set(pendingListeners);
      return connection;
    }

    report({
      state: "connecting",
      message: "Connecting to UNAI RTLS...",
    });

    const socket = io("https://socket.lailab.online", {
      path: "/ble/location",
      query: { token: socketToken },
      transports: ["websocket"],
      reconnection: false,
      forceNew: false,
      timeout: 10_000,
    }) as SocketLike;

    const current: Connection = {
      key,
      placeId,
      buildingId,
      floorId,
      socket,
      listeners: new Set(pendingListeners),
      reconnectTimer: null,
      reconnectAttempt,
      watchdogTimer: null,
      reconnecting: false,
      closed: false,
    };

    connection = current;

    const handleTag = (payload: unknown, eventName: string) => {
      // Drop ASSET records before they reach subscribers. This also prevents
      // LiveMap's console.log, timeline, map state and MongoDB POST from ever
      // seeing an object that explicitly says usage_type=ASSET.
      // IMPORTANT: never forward the raw UNAI payload. An Asset can appear
      // in initial data and realtime events with usage_type=ASSET. Filter the
      // complete object tree first, then notify subscribers only with the
      // sanitized payload.
      const filteredPayload = filterAssetPayload(payload);

      if (filteredPayload === undefined) return;
      if (Array.isArray(filteredPayload) && filteredPayload.length === 0) return;

      // If this payload contained an Asset and filtering removed everything
      // useful from it, do not pass an empty object through to LiveMap.
      if (
        containsAssetRecord(payload) &&
        filteredPayload &&
        typeof filteredPayload === "object" &&
        !Array.isArray(filteredPayload) &&
        Object.keys(filteredPayload as Record<string, unknown>).length === 0
      ) {
        return;
      }

      current.listeners.forEach((listener) => {
        try {
          listener({ payload: filteredPayload, eventName });
        } catch (error) {
          console.error("[UNAI RTLS] subscriber error:", error);
        }
      });
    };

    socket.on("connect", () => {
      // A successful connection resets the backoff. This means a stable
      // connection has no reconnect timers or periodic connection attempts.
      current.reconnectAttempt = 0;
      current.reconnecting = false;
      if (current.reconnectTimer !== null) {
        window.clearTimeout(current.reconnectTimer);
        current.reconnectTimer = null;
      }
      rateLimitedUntil = 0;

      report({
        state: "connected",
        message: `Connected as ${socket.id ?? "socket"}.`,
        socketId: socket.id,
      });

      const baseTopic = `unai/${placeId}/${buildingId}/${floorId}`;

      socket.emit("/register", {
        customId: `client_${buildingId}_${floorId}`,
      });

      socket.emit("/join", `${baseTopic}/tag`);
      socket.emit("/join", `${baseTopic}/anchor`);
      socket.emit("/join", `${baseTopic}/alert`);

      socket.emit("/broadcastToRoom", {
        room: "init_unai_location",
        data: {
          action: "get_init_unai_location",
          get_topic: `${placeId}/${buildingId}/${floorId}`,
        },
      });

      console.log("[UNAI RTLS] shared connection ready", {
        socketId: socket.id,
        floorId,
      });
    });

    socket.on("tag", (payload) => handleTag(payload, "tag"));
    socket.on("clientBox", (payload) => handleTag(payload, "clientBox"));
    socket.on("sensor", (payload) => handleTag(payload, "sensor"));
    socket.on("message", (payload) => handleTag(payload, "message"));

    const scheduleReconnect = (reason: string) => {
      if (current.closed || connection !== current || current.listeners.size === 0) return;
      if (current.reconnectTimer !== null || current.reconnecting) return;

      if (Date.now() < rateLimitedUntil) {
        const wait = Math.max(1_000, rateLimitedUntil - Date.now());
        current.reconnectTimer = window.setTimeout(() => {
          current.reconnectTimer = null;
          scheduleReconnect("rate-limit cooldown finished");
        }, wait);
        report({
          state: "rate_limited",
          message: `UNAI rate limit active. Reconnect paused for ${Math.ceil(wait / 1000)}s.`,
        });
        return;
      }

      if (current.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        report({
          state: "error",
          message: "Realtime reconnect stopped after 8 attempts. Waiting for a new page subscription.",
        });
        return;
      }

      current.reconnectAttempt += 1;
      const wait = reconnectDelay(current.reconnectAttempt);
      report({
        state: "disconnected",
        message: `${reason} Reconnecting in ${Math.ceil(wait / 1000)}s (attempt ${current.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`,
      });

      current.reconnectTimer = window.setTimeout(() => {
        current.reconnectTimer = null;
        if (current.closed || connection !== current || current.listeners.size === 0) return;

        current.reconnecting = true;
        reconnectingKey = current.key;
        reconnectPromise = reconnectConnection(current).finally(() => {
          current.reconnecting = false;
          if (reconnectingKey === current.key) {
            reconnectingKey = "";
            reconnectPromise = null;
          }
        });
      }, wait);
    };

    socket.on("connect_error", (error) => {
      console.error("[UNAI RTLS] connect_error:", error?.message || error);

      if (isRateLimit(error)) {
        rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        report({
          state: "rate_limited",
          message: "UNAI rate limit detected. Reconnect is paused for 60 seconds.",
        });
      } else {
        report({
          state: "error",
          message: `Socket connection error: ${String(
            (error as any)?.message || error
          )}`,
        });
      }

      if (connection === current) {
        current.socket.disconnect();
        scheduleReconnect("Socket connection failed.");
      }
    });

    socket.on("disconnect", (reason) => {
      console.log("[UNAI RTLS] shared socket disconnected:", reason);

      if (connection !== current || current.closed || current.listeners.size === 0) return;

      report({
        state: "disconnected",
        message: `Disconnected: ${reason}. Automatic reconnect is scheduled safely.`,
      });
      scheduleReconnect("Socket disconnected.");
    });

    // A lightweight watchdog catches cases where the browser/socket state is
    // stale but a disconnect event was missed. It checks every 10s only while
    // this shared connection has active subscribers; it never creates a new
    // connection by itself, it only schedules the same guarded backoff path.
    current.watchdogTimer = window.setInterval(() => {
      if (current.closed || connection !== current || current.listeners.size === 0) return;
      if (current.socket.connected) return;
      scheduleReconnect("Socket status is disconnected.");
    }, SOCKET_WATCHDOG_MS);

    return current;
  } catch (error) {
    report({
      state: isRateLimit(error) ? "rate_limited" : "error",
      message: String((error as any)?.message || error),
    });
    return null;
  }
}

async function reconnectConnection(current: Connection): Promise<void> {
  if (current.closed || connection !== current || current.listeners.size === 0) return;

  // Tear down only the dead socket. Keep the Connection object and its
  // subscribers so a reconnect does not force React components to resubscribe.
  current.socket.off("tag");
  current.socket.off("clientBox");
  current.socket.off("sensor");
  current.socket.off("message");
  current.socket.off("connect");
  current.socket.off("disconnect");
  current.socket.off("connect_error");
  current.socket.disconnect();
  stopConnectionTimers(current);

  connection = null;
  const replacement = await createConnection(
    current.key,
    current.placeId,
    current.buildingId,
    current.floorId,
    current.reconnectAttempt,
  );

  if (!replacement) {
    // createConnection can fail before a socket exists (for example while the
    // token endpoint is unavailable). Count that as a reconnect attempt too,
    // otherwise a failing auth endpoint could cause an endless request loop.
    if (!current.closed && pendingKey === current.key && pendingListeners.size > 0) {
      if (current.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        report({
          state: "error",
          message: "Realtime reconnect stopped after 8 attempts. Waiting for a new page subscription.",
        });
        connection = current;
        current.reconnecting = false;
        return;
      }

      current.reconnectAttempt += 1;
      connection = current;
      current.reconnecting = false;

      // createConnection reports the error; retry only once using the same
      // guarded backoff. A 429/known rate-limit cooldown takes precedence.
      const wait = Date.now() < rateLimitedUntil
        ? Math.max(1_000, rateLimitedUntil - Date.now())
        : reconnectDelay(current.reconnectAttempt);
      current.reconnectTimer = window.setTimeout(() => {
        current.reconnectTimer = null;
        if (connection === current) {
          current.reconnecting = true;
          reconnectingKey = current.key;
          reconnectPromise = reconnectConnection(current).finally(() => {
            current.reconnecting = false;
            if (reconnectingKey === current.key) {
              reconnectingKey = "";
              reconnectPromise = null;
            }
          });
        }
      }, wait);
    }
    return;
  }

  // createConnection replaces the shared connection and installs the same
  // guarded listeners. No second socket is left alive.
}

function ensureConnection(
  key: string,
  placeId: string | number,
  buildingId: string | number,
  floorId: string | number
) {
  if (connection?.key === key && connection.socket.connected) return Promise.resolve(connection);

  // A reconnect is already rebuilding this exact shared socket. Do not let a
  // second subscriber start another token/socket request while it is in flight.
  if (reconnectPromise && reconnectingKey === key) {
    return reconnectPromise.then(() => connection);
  }

  if (connectionPromise && pendingKey === key) {
    return connectionPromise;
  }

  if (connection && connection.key !== key) {
    closeConnection();
  }

  pendingKey = key;
  connectionPromise = createConnection(key, placeId, buildingId, floorId)
    .finally(() => {
      connectionPromise = null;
    });

  return connectionPromise;
}

export function subscribeUnaiRealtime({
  placeId,
  buildingId,
  floorId,
  onTag,
  onStatus,
}: {
  placeId: string | number;
  buildingId: string | number;
  floorId: string | number;
  onTag: Listener;
  onStatus?: (status: {
    state: string;
    message: string;
    socketId?: string;
  }) => void;
}) {
  let active = true;
  const key = `${String(placeId)}:${String(buildingId)}:${String(floorId)}`;

  clearDisconnectTimer();

  // Register the subscriber BEFORE starting async token/socket creation.
  // This fixes the race where React Strict Mode or two components subscribe
  // at the same time and the second listener was previously lost.
  pendingKey = key;
  pendingListeners.add(onTag);

  const statusListener = (status: {
    state: string;
    message: string;
    socketId?: string;
  }) => {
    if (active) onStatus?.(status);
  };

  pendingStatusListeners.add(statusListener);

  // If the connection already exists, attach immediately. If it is currently
  // disconnected, the manager's backoff/watchdog owns recovery; do not open a
  // second socket from this subscriber.
  if (connection?.key === key) {
    connection.listeners.add(onTag);
    onStatus?.({
      state: connection.socket.connected ? "connected" : "connecting",
      message: connection.socket.connected
        ? "Using shared UNAI realtime connection."
        : "Using the existing UNAI realtime connection.",
      socketId: connection.socket.id,
    });
  } else {
    void ensureConnection(key, placeId, buildingId, floorId);
  }

  return () => {
    active = false;
    pendingStatusListeners.delete(statusListener);
    pendingListeners.delete(onTag);

    if (connection?.key === key) {
      connection.listeners.delete(onTag);

      if (connection.listeners.size === 0) {
        clearDisconnectTimer();

        disconnectTimer = window.setTimeout(() => {
          if (connection?.key === key && connection.listeners.size === 0) {
            closeConnection();
          }
          disconnectTimer = null;
        }, GRACE_MS);
      }
    }

    if (pendingKey === key && pendingListeners.size === 0 && !connection) {
      // Cancel a pending connection logically. The async request itself cannot
      // be aborted here, but createConnection checks pendingListeners before
      // opening the actual socket, so it cannot create a new UNAI connection.
      pendingKey = "";
    }
  };
}

export function clearUnaiRealtimeTokenCache() {
  tokenCache.clear();
}
