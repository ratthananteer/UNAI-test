// UNAI AUTH SERVICE:
// Generates access tokens from the configured UNAI username/password.
// Tokens are kept in memory through process.env.ACCESS_TOKEN and refreshed
// before expiry or immediately after an authenticated API request returns 401/403.
// `refreshPromise` prevents several simultaneous requests from generating
// several tokens at the same time.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

let refreshPromise = null;
let accessTokenExpiresAt = 0;

// Keep a small safety window so we never intentionally use a token that is
// about to expire. The UNAI token is currently requested for 60 minutes.
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

async function generateAccessToken() {
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
