import "./loadEnv.js";
import mongoose from "mongoose";
import { config } from "./config.js";
import { createApp } from "./app.js";

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
const app = createApp();
app.listen(config.port, () => console.log(`API: http://localhost:${config.port}`));
