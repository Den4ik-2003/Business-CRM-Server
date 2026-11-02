import fs from "node:fs";
// Локально читає server/.env, якщо він є. На хостингу змінні задає платформа, файл не потрібен.
if (fs.existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
