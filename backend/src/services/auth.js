const crypto = require("crypto");
const User = require("../models/User");

const ACCESS_COOKIE = "unai_auth";
const JWT_ALGORITHM = "HS256";
const USER_TOKEN_DAYS = Math.max(1, Number(process.env.AUTH_USER_TOKEN_DAYS) || 30);
const ADMIN_TOKEN_MINUTES = Math.max(5, Number(process.env.AUTH_ADMIN_TOKEN_MINUTES) || 120);

function getSecret() {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_JWT_SECRET must be set and contain at least 32 characters");
  }
  return secret;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signJwt(payload) {
  const header = base64url(JSON.stringify({ alg: JWT_ALGORITHM, typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  const signature = crypto.createHmac("sha256", getSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifyJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid token");

  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", getSecret()).update(unsigned).digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error("Invalid token signature");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid token payload");
  }

  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }

  return payload;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const N = 16384;
  const r = 8;
  const p = 1;
  const key = crypto.scryptSync(password, salt, 64, { N, r, p, maxmem: 32 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt}$${key.toString("hex")}`;
}

function verifyPassword(password, encoded) {
  const [algorithm, n, r, p, salt, keyHex] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !salt || !keyHex) return false;

  try {
    const derived = crypto.scryptSync(password, salt, 64, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 32 * 1024 * 1024,
    });
    const expected = Buffer.from(keyHex, "hex");
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function validateCredentials(username, password) {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9._-]{3,64}$/.test(normalized)) {
    return "Username must be 3-64 characters and use only letters, numbers, ., _, or -.";
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return "Password must be 8-128 characters.";
  }
  return null;
}

function getConfiguredAdmin() {
  const username = normalizeUsername(process.env.AUTH_ADMIN_USERNAME);
  const password = process.env.AUTH_ADMIN_PASSWORD;

  if (!username || !password) return null;

  const validationError = validateCredentials(username, password);
  if (validationError) {
    throw new Error(`AUTH_ADMIN credentials invalid: ${validationError}`);
  }

  return { username, password };
}

function safeEqualStrings(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isConfiguredAdmin(username, password) {
  const configured = getConfiguredAdmin();
  if (!configured) return false;
  return (
    normalizeUsername(username) === configured.username &&
    safeEqualStrings(password, configured.password)
  );
}

function createToken(user, remember) {
  const now = Math.floor(Date.now() / 1000);
  const isEnvAdmin = user.authType === "env-admin";
  const ttl = user.role === "admin"
    ? ADMIN_TOKEN_MINUTES * 60
    : (remember ? USER_TOKEN_DAYS * 24 * 60 * 60 : 24 * 60 * 60);

  return signJwt({
    sub: String(user._id || user.id),
    username: user.username,
    role: user.role,
    authType: isEnvAdmin ? "env-admin" : "mongo",
    sv: user.sessionVersion || 0,
    iat: now,
    exp: now + ttl,
  });
}

function createEnvAdminToken(username) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: `env-admin:${normalizeUsername(username)}`,
    username: normalizeUsername(username),
    role: "admin",
    authType: "env-admin",
    sv: 0,
    iat: now,
    exp: now + ADMIN_TOKEN_MINUTES * 60,
  });
}

function parseCookies(header) {
  const result = {};
  for (const item of String(header || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function getTokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[ACCESS_COOKIE] || null;
}

async function authenticateRequest(req) {
  const token = getTokenFromRequest(req);
  if (!token) return null;

  try {
    const payload = verifyJwt(token);

    if (payload.authType === "env-admin") {
      const configured = getConfiguredAdmin();
      if (!configured || payload.role !== "admin" || payload.username !== configured.username) return null;
      return {
        id: String(payload.sub),
        username: configured.username,
        role: "admin",
        authType: "env-admin",
      };
    }

    const user = await User.findById(payload.sub).select("username role sessionVersion").lean();
    if (!user) return null;
    if (Number(user.sessionVersion || 0) !== Number(payload.sv || 0)) return null;
    return { id: String(user._id), username: user.username, role: user.role, authType: "mongo" };
  } catch {
    return null;
  }
}

function setAuthCookie(res, token, user, remember = true) {
  const isProduction = process.env.NODE_ENV === "production";
  const options = [
    `${ACCESS_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isProduction) options.push("Secure");

  // Normal users get a persistent cookie after choosing Remember me. Admins
  // deliberately receive a session cookie only, so closing the browser logs
  // them out.
  if (user.role === "user" && remember) {
    const maxAge = USER_TOKEN_DAYS * 24 * 60 * 60;
    options.push(`Max-Age=${maxAge}`);
  }

  res.setHeader("Set-Cookie", options.join("; "));
}

function clearAuthCookie(res) {
  const options = [
    `${ACCESS_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") options.push("Secure");
  res.setHeader("Set-Cookie", options.join("; "));
}

function authRequired() {
  return async (req, res, next) => {
    const user = await authenticateRequest(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    req.user = user;
    return next();
  };
}

function adminRequired() {
  return async (req, res, next) => {
    const user = await authenticateRequest(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    req.user = user;
    return next();
  };
}

// Render environment credentials are an optional server-only admin identity.
// They are validated at startup but are NOT copied into MongoDB. This keeps
// the admin login independent from the users collection.
async function ensureBootstrapAdmin() {
  const configured = getConfiguredAdmin();
  if (configured) {
    console.log(`[Auth] Environment admin enabled: ${configured.username}`);
  }
}

module.exports = {
  ACCESS_COOKIE,
  hashPassword,
  verifyPassword,
  normalizeUsername,
  validateCredentials,
  isConfiguredAdmin,
  createToken,
  createEnvAdminToken,
  authenticateRequest,
  setAuthCookie,
  clearAuthCookie,
  authRequired,
  adminRequired,
  ensureBootstrapAdmin,
};
