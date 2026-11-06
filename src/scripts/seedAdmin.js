import "../loadEnv.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { User } from "../models/index.js";

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
const email = (process.env.ADMIN_EMAIL || "").toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";
if (!email || password.length < 12) throw new Error("Задайте ADMIN_EMAIL та ADMIN_PASSWORD (від 12 символів) у server/.env");
if (await User.exists({ email })) console.log("Власник уже існує — нічого не змінено");
else {
  await User.create({ email, name: process.env.ADMIN_NAME || "Власник", role: "owner", passwordHash: await bcrypt.hash(password, 12) });
  console.log(`Створено власника: ${email}`);
}
await mongoose.disconnect();
