"use client";

export type RealtimeState =
  | "loading"
  | "connecting"
  | "connected"
  | "rate_limited"
  | "error"
  | "disconnected";

export type RealtimeStatus = {
  state: RealtimeState;
  message: string;
  socketId?: string | null;
};

type RealtimeOptions = {
  placeId?: number | string;
  buildingId?: number | string;
  floorId?: number | string;
  onStatus?: (status: RealtimeStatus) => void;
  onTag?: (event: { payload: unknown; eventName: string }) => void;
};

type Listener = {
  options: RealtimeOptions;
  active: boolean;
};

let eventSource: EventSource | null = null;
let startPromise: Promise<void> | null = null;
const listeners = new Set<Listener>();

let retryTimer: number | null = null;
let retryAttempt = 0;
let rateLimitedUntil = 0;

const MAX_RETRY_MS = 60_000;
const RATE_LIMIT_WAIT_MS = 5 * 60_000;

function notifyStatus(status: RealtimeStatus) {
  for (const listener of listeners) {
    if (!listener.active) continue;
    try {
      listener.options.onStatus?.(status);
    } catch (error) {
      console.error("[Realtime] status listener error:", error);
    }
  }
}

function matchesScope(options: RealtimeOptions, record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const item = record as Record<string, unknown>;

  const building = item.buildingId ?? item.building_id ?? item.building;
  const floor = item.floorId ?? item.floor_id ?? item.floor ?? item.floorID;

  if (options.buildingId != null && building != null && String(building) !== String(options.buildingId)) {
    return false;
  }

  if (options.floorId != null && floor != null && String(floor) !== String(options.floorId)) {
    return false;
  }

  return true;
}

function emitTagPayload(payload: unknown, eventName: string) {
  let records: unknown[] = [];

  if (Array.isArray(payload)) {
    records = payload;
  } else if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    if (Array.isArray(object.tags)) records = object.tags;
    else if (Array.isArray(object.records)) records = object.records;
    else if (Array.isArray(object.data)) records = object.data;
    else records = [payload];
  }

  for (const listener of listeners) {
    if (!listener.active) continue;

    const scoped = records.filter((record) => matchesScope(listener.options, record));
    if (!scoped.length) continue;

    try {
      listener.options.onTag?.({
        payload: scoped,
        eventName,
      });
    } catch (error) {
      console.error("[Realtime] tag listener error:", error);
    }
  }
}

function clearRetryTimer() {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(reason: "disconnect" | "rate_limit" | "error") {
  if (retryTimer !== null || listeners.size === 0) return;

  const now = Date.now();
  let delay: number;

  if (reason === "rate_limit") {
    if (!rateLimitedUntil) rateLimitedUntil = now + RATE_LIMIT_WAIT_MS;
    delay = Math.max(1_000, rateLimitedUntil - now);
  } else {
    const exponent = Math.min(retryAttempt, 6);
    const base = Math.min(MAX_RETRY_MS, 1_000 * 2 ** exponent);
    const jitter = Math.floor(Math.random() * 1_000);
    delay = Math.min(MAX_RETRY_MS, base + jitter);
    retryAttempt += 1;
  }

  notifyStatus({
    state: reason === "rate_limit" ? "rate_limited" : "disconnected",
    message:
      reason === "rate_limit"
        ? `Realtime rate limited. Retrying in ${Math.ceil(delay / 1000)}s without creating another connection.`
        : `Realtime disconnected. Retrying in ${Math.ceil(delay / 1000)}s.`,
  });

  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (listeners.size === 0) return;
    void connectShared();
  }, delay);
}

function closeSharedSource() {
  if (!eventSource) return;
  eventSource.close();
  eventSource = null;
}

async function connectShared(): Promise<void> {
  if (listeners.size === 0 || typeof window === "undefined") return;
  if (eventSource || startPromise) return startPromise ?? Promise.resolve();

  const now = Date.now();
  if (now < rateLimitedUntil) {
    scheduleRetry("rate_limit");
    return;
  }

  notifyStatus({ state: "connecting", message: "Connecting to shared realtime stream..." });

  startPromise = new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      const source = new EventSource("/api/realtime", { withCredentials: true });
      eventSource = source;

      source.addEventListener("open", () => {
        retryAttempt = 0;
        rateLimitedUntil = 0;
        notifyStatus({ state: "connected", message: "Realtime stream connected." });
        settle();
      });

      source.addEventListener("snapshot", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data);
          emitTagPayload(payload, "snapshot");
        } catch (error) {
          console.error("[Realtime] invalid snapshot event:", error);
        }
      });

      source.addEventListener("tags", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data);
          emitTagPayload(payload, "tags");
        } catch (error) {
          console.error("[Realtime] invalid tags event:", error);
        }
      });

      source.addEventListener("error", (event) => {
        // Backend error events are application-level SSE events. EventSource's
        // network error is handled by source.onerror below.
        try {
          const messageEvent = event as MessageEvent;
          const payload = JSON.parse(String(messageEvent.data ?? "{}"));
          if (payload?.rateLimited || /rate.?limit|too many/i.test(String(payload?.message ?? ""))) {
            rateLimitedUntil = Date.now() + RATE_LIMIT_WAIT_MS;
            notifyStatus({
              state: "rate_limited",
              message: "Realtime is rate limited. Waiting before reconnecting.",
            });
          }
        } catch {
          // Ignore non-JSON application errors.
        }
      });

      source.onerror = () => {
        closeSharedSource();
        settle();

        if (listeners.size === 0) return;

        // EventSource already performs its own automatic reconnect. We close it
        // deliberately and use one controlled timer instead, because the UNAI
        // upstream has a connection-attempt limiter and browser-native retries
        // are too aggressive for this application.
        scheduleRetry(rateLimitedUntil > Date.now() ? "rate_limit" : "error");
      };
    } catch (error) {
      closeSharedSource();
      notifyStatus({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      settle();
      scheduleRetry("error");
    }
  }).finally(() => {
    startPromise = null;
  });

  return startPromise;
}

export async function subscribeUnaiRealtime(options: RealtimeOptions): Promise<() => void> {
  const listener: Listener = { options, active: true };
  listeners.add(listener);

  if (listeners.size === 1) {
    await connectShared();
  } else if (eventSource) {
    options.onStatus?.({ state: "connected", message: "Using shared realtime stream." });
  }

  return () => {
    if (!listener.active) return;
    listener.active = false;
    listeners.delete(listener);

    if (listeners.size === 0) {
      clearRetryTimer();
      closeSharedSource();
      retryAttempt = 0;
      rateLimitedUntil = 0;
    }
  };
}
