const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 64,
      index: true,
    },
    // Passwords are never stored in plaintext. This field contains a scrypt
    // hash in the format: scrypt$N$r$p$salt$derivedKey.
    password: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
      index: true,
    },
    // Incrementing this invalidates every previously issued JWT for the user.
    sessionVersion: {
      type: Number,
      default: 0,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "users",
  },
);

module.exports = mongoose.models.User || mongoose.model("User", UserSchema);
