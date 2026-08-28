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

  const response = await fetch("https://rtls.lailab.online/auth/gen_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username,
      password,
      token_expire_time_in_minute: "60",
      refresh_token_expire_time_in_minute: "60",
      socket_token_type: "rs256",
    }),
  });

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

  if (!response.ok || !accessToken) {
    const error = new Error(`Failed to generate UNAI access token: HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  process.env.ACCESS_TOKEN = accessToken;

  // The token request above asks UNAI for 60 minutes. Keep the expiry in
  // memory so a long-running Render process refreshes it before expiry.
  accessTokenExpiresAt = Date.now() + 60 * 60 * 1000;

  console.log("[UNAI AUTH] Access token refreshed successfully.");
  return accessToken;
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

module.exports = { getAccessToken, refreshAccessToken };
