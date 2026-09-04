// UNAI API SERVICE:
// Sends authenticated HTTP requests to the external UNAI RTLS API.
// It obtains a generated access token from unaiAuth and automatically generates
// a replacement token once when UNAI responds with 401/403.
// It also generates the per-floor Socket.IO topic credentials for the frontend.

const { getAccessToken, refreshAccessToken } = require("./unaiAuth");

const socketTopicCache = new Map();
const socketTopicPromises = new Map();
const SOCKET_TOPIC_CACHE_MS = 5 * 60_000;

async function fetchFromApi(url, errorMessage, retryAfterUnauthorized = true) {
  if (!url) {
    throw new Error(`${errorMessage}: API URL is not configured`);
  }

  const accessToken = await getAccessToken();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if ((response.status === 401 || response.status === 403) && retryAfterUnauthorized) {
    console.warn(`[UNAI AUTH] ${errorMessage} returned ${response.status}. Generating a new access token...`);
    await refreshAccessToken();
    return fetchFromApi(url, errorMessage, false);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`${errorMessage}: HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5 * 60 * 1000)
        : 60_000;
      error.message = `${errorMessage}: HTTP 429 (rate limited; retry after ${Math.ceil(error.retryAfterMs / 1000)}s)`;
    }

    throw error;
  }

  return response.json();
}

async function generateSocketTopic(floorID) {
  const key = String(floorID);
  const cached = socketTopicCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const existingPromise = socketTopicPromises.get(key);
  if (existingPromise) return existingPromise;

  const requestPromise = generateSocketTopicRequest(floorID);
  socketTopicPromises.set(key, requestPromise);

  try {
    return await requestPromise;
  } finally {
    socketTopicPromises.delete(key);
  }
}

async function generateSocketTopicRequest(floorID) {
  const url = "https://rtls.lailab.online/gen_encrypt_topic";
  const body = new URLSearchParams({ floorID: String(floorID) });

  let response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (response.status === 401 || response.status === 403) {
    console.warn(`[UNAI AUTH] /gen_encrypt_topic returned ${response.status}. Generating a new access token...`);
    await refreshAccessToken();

    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ floorID: String(floorID) }),
    });
  }

  const rawBody = await response.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    data = { raw: rawBody };
  }

  if (!response.ok) {
    const error = new Error(`Failed to generate socket topic: HTTP ${response.status}`);
    error.status = response.status;
    error.body = data;
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5 * 60 * 1000)
        : 60_000;
      error.message = `Failed to generate socket topic: HTTP 429 (rate limited; retry after ${Math.ceil(error.retryAfterMs / 1000)}s)`;
    }
    throw error;
  }

  if (!data?.socket_token) {
    const error = new Error("Socket topic response is missing socket_token");
    error.status = 502;
    error.body = data;
    throw error;
  }

  const value = {
    socket_token: data.socket_token,
    ...(data.encrypt_topic ? { encrypt_topic: data.encrypt_topic } : {}),
  };

  socketTopicCache.set(String(floorID), {
    value,
    expiresAt: Date.now() + SOCKET_TOPIC_CACHE_MS,
  });

  return value;
}

module.exports = { fetchFromApi, generateSocketTopic };
