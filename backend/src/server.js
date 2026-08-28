const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const { connectMongo } = require("./services/mongo.js");
const { startTagMonitor } = require("./services/tagMonitor.js");
const { syncStaticData } = require("./services/staticDataCache.js");
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

    // Populate/update static building configuration on startup. The web
    // endpoints remain cache-first, so normal page loads use MongoDB.
    try {
      console.log("[StaticData] Startup sync checking Place/Building/Floor/Zone...");
      const result = await syncStaticData();
      console.log("[StaticData] Startup sync complete:", result);
    } catch (error) {
      // Do not prevent Render from starting if UNAI is temporarily unavailable.
      console.error("[StaticData] Startup sync failed; server will use existing MongoDB cache:", error.message);
    }

    startTagMonitor();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Backend] Running on 0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error("[MongoDB] Connection failed:", error);
    process.exit(1);
  }
}

startServer();
