import "../loadEnv.js";
// «Міграція» для MongoDB: створює колекції та синхронізує індекси з описаних моделей.
// Безпечно запускати повторно. Індекси, яких немає в моделях, видаляються (syncIndexes).
import mongoose from "mongoose";
import * as models from "../models/index.js";
import { InterestLevel, InterestChannel } from "../models/index.js";
import { config } from "../config.js";

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
for (const [name, Model] of Object.entries(models)) {
  if (!Model?.syncIndexes) continue;
  await Model.createCollection().catch(() => {});
  const dropped = await Model.syncIndexes();
  console.log(`✓ ${name}${dropped.length ? ` (видалено застарілих індексів: ${dropped.length})` : ""}`);
}
for (const item of [{name:"Низький",weight:20},{name:"Середній",weight:50},{name:"Високий",weight:80},{name:"Гарячий",weight:100}])
  await InterestLevel.updateOne({name:item.name},{$setOnInsert:item},{upsert:true});
for (const name of ["Instagram","Threads","OLX","TikTok","Facebook","Telegram","Інший"])
  await InterestChannel.updateOne({name},{$setOnInsert:{name}},{upsert:true});
const rs = await mongoose.connection.db.admin().command({ hello: 1 });
if (!rs.setName) console.warn("⚠ MongoDB працює без replica set — транзакції не працюватимуть. Використайте docker compose.");
await mongoose.disconnect();
