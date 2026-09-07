// UNAI AUTH SERVICE:
// Generates access tokens from the configured UNAI username/password.
// Tokens are kept in memory through process.env.ACCESS_TOKEN and refreshed
// before expiry or immediately after an authenticated API request returns 401/403.
// `refreshPromise` prevents several simultaneous requests from generating
// several tokens at the same time.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

let refreshPromise = null;
let generatePromise = null;
let accessTokenExpiresAt = 0;
let authRateLimitedUntil = 0;
const AUTH_RATE_LIMIT_COOLDOWN_MS = 60_000;

// Keep a small safety window so we never intentionally use a token that is
// about to expire. The UNAI token is currently requested for 60 minutes.
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

async function generateAccessTokenRequest() {
  if (Date.now() < authRateLimitedUntil) {
    const error = new Error("UNAI authentication is temporarily rate-limited. Please wait before requesting another token.");
    error.status = 429;
    error.retryAfterMs = authRateLimitedUntil - Date.now();
    throw error;
  }

  const username = process.env.UNAI_USERNAME;
  const password = process.env.UNAI_PASSWORD;

  if (!username || !password) {
    throw new Error("UNAI_USERNAME and UNAI_PASSWORD must be configured in .env");
  }

  const requestBody = new URLSearchParams({
    username,
    password,
    token_expire_time_in_minute: "60",
    refresh_token_expire_time_in_minute: "60",
    socket_token_type: "rs256",
  });

  // UNAI deployments have used both the root auth route and the /api auth
  // route. A 404 means the route is not mounted on that deployment, so try
  // the known route variants before failing the request.
  const authUrls = [
    "https://rtls.lailab.online/auth/gen_token",
    "https://rtls.lailab.online/auth/gen_token/",
    "https://rtls.lailab.online/api/auth/gen_token",
    "https://rtls.lailab.online/api/auth/gen_token/",
  ];

  let lastStatus = 500;
  let lastBody = "";

  for (const url of authUrls) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: requestBody,
      });
    } catch (requestError) {
      console.warn(`[UNAI AUTH] Request failed for ${url}:`, requestError);
      continue;
    }

    const body = await response.text().catch(() => "");
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      data = null;
    }

    const accessToken =
      data?.access_token ??
      data?.accessToken ??
      data?.token ??
      data?.data?.access_token ??
      data?.data?.accessToken ??
      data?.data?.token;

    if (response.ok && accessToken) {
      process.env.ACCESS_TOKEN = accessToken;
      accessTokenExpiresAt = Date.now() + 60 * 60 * 1000;
      console.log(`[UNAI AUTH] Access token refreshed successfully via ${url}`);
      return accessToken;
    }

    lastStatus = response.status;
    lastBody = body;

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      authRateLimitedUntil = Date.now() + (
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5 * 60 * 1000)
          : AUTH_RATE_LIMIT_COOLDOWN_MS
      );
      const error = new Error("Failed to generate UNAI access token: HTTP 429");
      error.status = 429;
      error.body = body;
      error.retryAfterMs = authRateLimitedUntil - Date.now();
      throw error;
    }

    // A 404 is specifically a route mismatch. Continue to the next known
    // route instead of immediately breaking the Home page.
    if (response.status === 404) {
      console.warn(`[UNAI AUTH] ${url} returned 404; trying the next auth route.`);
      continue;
    }

    const error = new Error(`Failed to generate UNAI access token: HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  const error = new Error(`Failed to generate UNAI access token: HTTP ${lastStatus}`);
  error.status = lastStatus;
  error.body = lastBody;
  throw error;
}

async function generateAccessToken() {
  // Single-flight even for callers that explicitly request token generation.
  // This prevents multiple pages/routes from hitting /auth/gen_token at once.
  if (!generatePromise) {
    generatePromise = generateAccessTokenRequest().finally(() => {
      generatePromise = null;
    });
  }
  return generatePromise;
}

async function getAccessToken() {
  const token = process.env.ACCESS_TOKEN;
  const stillValid = token && Date.now() < accessTokenExpiresAt - TOKEN_REFRESH_SKEW_MS;

  if (stillValid) return token;

  // Clear an expired in-memory token before generating a replacement.
  if (token) {
    process.env.ACCESS_TOKEN = "";
  }

  if (!refreshPromise) {
    refreshPromise = generateAccessToken().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

async function refreshAccessToken() {
  // Always replace the current token when an API explicitly reports that it
  // is unauthorized. Do not return the expired token from getAccessToken().
  process.env.ACCESS_TOKEN = "";
  accessTokenExpiresAt = 0;

  if (!refreshPromise) {
    refreshPromise = generateAccessToken().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

module.exports = { getAccessToken, refreshAccessToken, generateAccessToken };
