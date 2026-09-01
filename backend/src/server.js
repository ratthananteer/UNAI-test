// BACKEND STARTUP FLOW:
// 1. Load environment variables from backend/.env.
// 2. Connect to MongoDB.
// 3. Synchronize static RTLS data into the MongoDB cache.
// 4. Start the tag activity monitor.
// 5. Start Express and expose all /api routes.
// This file is the main server bootstrap for the Node.js backend.

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const { connectMongo } = require("./services/mongo.js");
const { startTagMonitor } = require("./services/tagMonitor.js");
const { start: startUnaiSocketCollector } = require("./services/unaiSocketManager.js");
const { getCachedOrFetch } = require("./services/staticDataCache.js");
const { fetchFromApi } = require("./services/unaiApi.js");
// Static data is synchronized on demand from the Home page/API.
// Do not authenticate with UNAI during backend startup.
const express = require("express");
const cors = require("cors");
const apiRoutes = require("./routes/api");

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());
app.use("/api", apiRoutes);

async function startServer() {
  try {
    await connectMongo();

    startTagMonitor();

    // History collection belongs to the backend, not to a browser page.
    // Load floors from MongoDB (or fetch/cache them once), then keep one
    // shared UNAI Socket.IO connection alive for all floors. TagEvent history
    // therefore continues even when no frontend page is open.
    try {
      const floors = await getCachedOrFetch("floor", () =>
        fetchFromApi(process.env.APIFLOOR_URL, "Failed to get floors"),
      );
      await startUnaiSocketCollector({ floors });
      console.log(`[HistoryCollector] Started for ${Array.isArray(floors) ? floors.length : 0} floor(s)`);
    } catch (error) {
      console.error("[HistoryCollector] Startup failed:", error.message);
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Backend] Running on 0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error("[MongoDB] Connection failed:", error);
    process.exit(1);
  }
}

startServer();
