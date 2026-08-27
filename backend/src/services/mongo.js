const mongoose = require("mongoose");

async function connectMongo() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is not defined in .env");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(uri);

  console.log("[MongoDB] Connected");

  return mongoose.connection;
}

module.exports = {
  connectMongo,
};