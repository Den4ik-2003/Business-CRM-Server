import "../loadEnv.js";
// «Міграція» для MongoDB: створює колекції та синхронізує індекси з описаних моделей.
// Безпечно запускати повторно. Індекси, яких немає в моделях, видаляються (syncIndexes).
import mongoose from "mongoose";
import * as models from "../models/index.js";
import { config } from "../config.js";

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
for (const [name, Model] of Object.entries(models)) {
  if (!Model?.syncIndexes) continue;
  await Model.createCollection().catch(() => {});
  const dropped = await Model.syncIndexes();
  console.log(`✓ ${name}${dropped.length ? ` (видалено застарілих індексів: ${dropped.length})` : ""}`);
}
const rs = await mongoose.connection.db.admin().command({ hello: 1 });
if (!rs.setName) console.warn("⚠ MongoDB працює без replica set — транзакції не працюватимуть. Використайте docker compose.");
await mongoose.disconnect();
