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
  authRequired,
} = require("../services/Auth");

const router = express.Router();

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

    const user = await User.create({
      username,
      password: hashPassword(password),
      role: "user",
    });

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
  const user = await authenticateRequest(req);
  if (!user) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, user });
});

router.post("/logout", authRequired(), async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, { $inc: { sessionVersion: 1 } });
  } catch (error) {
    console.error("[Auth] logout session invalidation error:", error);
  }
  clearAuthCookie(res);
  return res.json({ ok: true });
});

module.exports = router;
