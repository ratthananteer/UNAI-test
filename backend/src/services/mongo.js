// MONGODB CONNECTION:
// Reads MONGODB_URI from the environment and opens one shared Mongoose connection.
// If a connection already exists, it reuses it instead of opening another one.

const mongoose = require("mongoose");

async function connectMongo() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is not defined in .env");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(uri, {
    // Keep one shared pool instead of opening connections per request.
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE) || 20,
    minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE) || 2,
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS) || 10_000,
    socketTimeoutMS: Number(process.env.MONGODB_SOCKET_TIMEOUT_MS) || 45_000,
  });
  console.log("[MongoDB] Connected");

  return mongoose.connection;
}

module.exports = { connectMongo };
