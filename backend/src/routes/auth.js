const express = require("express");
const User = require("../models/User");
const {
  hashPassword,
  verifyPassword,
  normalizeUsername,
  validateCredentials,
  createToken,
  authenticateRequest,
  setAuthCookie,
  clearAuthCookie,
} = require("../services/auth");

const router = express.Router();

// Deployment marker: this must appear once in the unai-backend Render logs
// after a new deploy. It lets us distinguish the new auth code from an old
// container that is still serving traffic.
console.log("[AUTH][BACKEND] auth routes loaded - logout-debug-v2");

function publicUser(user) {
  return {
    id: String(user._id || user.id),
    username: user.username,
    role: user.role,
  };
}

router.post("/register", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;
    const validationError = validateCredentials(username, password);
    if (validationError) return res.status(400).json({ error: validationError });

    const exists = await User.exists({ username });
    if (exists) return res.status(409).json({ error: "Username is already registered." });

    const user = await User.create({ username, password: hashPassword(password), role: "user" });
    const token = createToken(user, true);
    setAuthCookie(res, token, user, true);
    return res.status(201).json({ user: publicUser(user), message: "Registration successful" });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: "Username is already registered." });
    console.error("[Auth] register error:", error);
    return res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;
    const remember = Boolean(req.body?.remember);

    if (!username || typeof password !== "string") {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const user = await User.findOne({ username }).select("+password");
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    user.lastLoginAt = new Date();
    await user.save();
    const token = createToken(user, remember);
    setAuthCookie(res, token, user, remember);
    return res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("[Auth] login error:", error);
    return res.status(500).json({ error: "Login failed" });
  }
});

router.get("/me", async (req, res) => {
  const hasAuthCookie = String(req.headers.cookie || "").split(";").some((item) => item.trim().startsWith("unai_auth="));
  const user = await authenticateRequest(req);
  console.log("[AUTH][BACKEND] /me", {
    hasAuthCookie,
    authenticated: Boolean(user),
    username: user?.username,
    role: user?.role,
  });
  if (!user) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, user });
});

// Logout is intentionally idempotent: even if the JWT is already invalid or
// expired, always clear the browser cookie. This prevents a broken/stale
// session from blocking logout at authRequired() before the handler runs.
router.post("/logout", async (req, res) => {
  const hasAuthCookie = String(req.headers.cookie || "").split(";").some((item) => item.trim().startsWith("unai_auth="));
  console.log("[AUTH][BACKEND] POST /logout", { hasAuthCookie });

  try {
    const user = await authenticateRequest(req);
    console.log("[AUTH][BACKEND] logout authentication", {
      authenticated: Boolean(user),
      username: user?.username,
      userId: user?.id,
    });

    if (user?.id) {
      const result = await User.findByIdAndUpdate(user.id, { $inc: { sessionVersion: 1 } });
      console.log("[AUTH][BACKEND] session invalidated", {
        userId: user.id,
        updated: Boolean(result),
      });
    } else {
      console.log("[AUTH][BACKEND] no valid session; clearing cookie anyway");
    }
  } catch (error) {
    console.error("[AUTH][BACKEND] logout invalidation error:", error);
  } finally {
    clearAuthCookie(res);
    console.log("[AUTH][BACKEND] auth cookie cleared");
  }

  return res.json({ ok: true });
});

module.exports = router;
