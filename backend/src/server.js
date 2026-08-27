const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const { connectMongo } = require("./services/mongo.js");
const { startTagMonitor } = require("./services/tagMonitor.js");
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

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Backend] Running on 0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error("[MongoDB] Connection failed:", error);
    process.exit(1);
  }
}

startServer();
