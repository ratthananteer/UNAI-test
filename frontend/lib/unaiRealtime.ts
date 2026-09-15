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

export type CanonicalTagPosition = {
  id: string | number;
  tagId: string | number;
  placeId: string | number | null;
  buildingId: string | number | null;
  floorId: string | number | null;
  zoneId: string | null;
  zoneName: string | null;
  x: number;
  y: number;
  z: number | null;
  timestamp: string;
  lastSeenAt: string | null;
  firstName: string | null;
  lastName: string | null;
  uiDisplay: string | null;
  groupId: string | number | null;
  groupName: string | null;
  tagType: string | null;
  batteryLevel: number | null;
  placeName: string | null;
  buildingName: string | null;
  floorName: string | null;
  rawData?: unknown;
};

type Listener = {
  options: RealtimeOptions;
  active: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function timestampIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const ms = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

export function normalizeCanonicalPosition(value: unknown): CanonicalTagPosition | null {
  const item = asRecord(value);
  if (!item) return null;
  const rawTagId = item.tagId ?? item.tag_id ?? item.tagID ?? item.id;
  const x = numberValue(item.x ?? item.pos_x ?? item.position_x);
  const y = numberValue(item.y ?? item.pos_y ?? item.position_y);
  if (rawTagId == null || x === null || y === null) return null;

  const timestamp = timestampIso(item.timestamp ?? item.lastSeenAt ?? item.last_seen ?? item.unix_time ?? item.unixTime ?? item.date_now ?? item.created_at);
  return {
    id: typeof rawTagId === "number" ? rawTagId : String(rawTagId),
    tagId: typeof rawTagId === "number" ? rawTagId : String(rawTagId),
    placeId: stringOrNull(item.placeId ?? item.place_id ?? item.place),
    buildingId: stringOrNull(item.buildingId ?? item.building_id ?? item.building),
    floorId: stringOrNull(item.floorId ?? item.floor_id ?? item.floor ?? item.floorID),
    zoneId: stringOrNull(item.zoneId ?? item.zone_id ?? item.zoneID ?? item.inExpectedZone),
    zoneName: stringOrNull(item.zoneName ?? item.zone_name ?? item.inExpectedZoneName),
    x,
    y,
    z: numberValue(item.z ?? item.pos_z ?? item.position_z),
    timestamp,
    lastSeenAt: item.lastSeenAt != null ? timestampIso(item.lastSeenAt) : null,
    firstName: stringOrNull(item.firstName ?? item.firstname ?? item.first_name),
    lastName: stringOrNull(item.lastName ?? item.lastname ?? item.last_name),
    uiDisplay: stringOrNull(item.uiDisplay ?? item.ui_display ?? item.tagName ?? item.tag_name ?? item.label),
    groupId:
      typeof (item.groupId ?? item.group_id) === "string" || typeof (item.groupId ?? item.group_id) === "number"
        ? (item.groupId ?? item.group_id) as string | number
        : null,
    groupName: stringOrNull(item.groupName ?? item.group_name),
    tagType: stringOrNull(item.tagType ?? item.tag_type),
    batteryLevel: numberValue(item.batteryLevel ?? item.batt ?? item.battery),
    placeName: stringOrNull(item.placeName ?? item.place_name),
    buildingName: stringOrNull(item.buildingName ?? item.building_name),
    floorName: stringOrNull(item.floorName ?? item.floor_name),
    rawData: item,
  };
}

let eventSource: EventSource | null = null;
let startPromise: Promise<void> | null = null;
const listeners = new Set<Listener>();

let retryTimer: number | null = null;
let retryAttempt = 0;
let rateLimitedUntil = 0;
let authenticationRequired = false;

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

function matchesScope(options: RealtimeOptions, record: unknown): record is Record<string, unknown> {
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

    const scoped = records
      .map((record) => normalizeCanonicalPosition(record))
      .filter((record): record is CanonicalTagPosition => record !== null)
      .filter((record) => matchesScope(listener.options, record));
    if (!scoped.length) continue;

    console.log("[Realtime] POSITION DATA RECEIVED", {
      eventName,
      count: scoped.length,
      positions: scoped.slice(0, 20).map((record) => ({
        tagId: record.tagId,
        buildingId: record.buildingId,
        floorId: record.floorId,
        x: record.x,
        y: record.y,
        timestamp: record.timestamp,
      })),
    });

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
  // A 401 from /api/realtime means the application session is missing or
  // expired. Retrying the same SSE request cannot restore authentication and
  // only creates a reconnect loop. Wait for a fresh login instead.
  if (authenticationRequired) return;
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
  if (authenticationRequired) return;
  if (eventSource || startPromise) return startPromise ?? Promise.resolve();

  // EventSource cannot expose the HTTP response status from onerror. Check the
  // app session explicitly first so an expired/missing cookie becomes a clear
  // authentication state instead of an endless "disconnected" reconnect loop.
  try {
    const authResponse = await fetch("/api/auth/me", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { "Cache-Control": "no-store" },
    });

    if (authResponse.status === 401) {
      authenticationRequired = true;
      clearRetryTimer();
      notifyStatus({
        state: "error",
        message: "Authentication required. Please sign in again.",
      });
      return;
    }

    if (!authResponse.ok) {
      scheduleRetry("error");
      return;
    }
  } catch (error) {
    notifyStatus({
      state: "error",
      message: "Unable to verify the login session. Retrying...",
    });
    scheduleRetry("error");
    return;
  }

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

        // The EventSource API does not expose the HTTP status here. Before
        // retrying, the next connectShared() call verifies /api/auth/me and
        // stops permanently if the session has expired.

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
    // A new subscription after a previous 401 is allowed to re-check the
    // session. This is useful after the user logs in again without a full app
    // reload.
    authenticationRequired = false;
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
      authenticationRequired = false;
    }
  };
}
