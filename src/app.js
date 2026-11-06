import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { requireAuth, ownerOnly } from "./middleware/auth.js";
import { notFound, errorHandler } from "./middleware/error.js";
import auth from "./routes/auth.js";
import users from "./routes/users.js";
import products from "./routes/products.js";
import inventory from "./routes/inventory.js";
import sales from "./routes/sales.js";
import expenses from "./routes/expenses.js";
import attachments from "./routes/attachments.js";
import { categories, suppliers, warehouses } from "./routes/reference.js";
import interests, { interestLevels, interestChannels } from "./routes/interests.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // за проксі хостингу: правильний IP і secure-cookie
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.clientOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.get("/api/health", (_q, res) => res.json({ ok: true }));
  app.use("/api/auth", auth);
  app.use("/api", requireAuth);
  app.use("/api/users", ownerOnly, users);
  app.use("/api/products", products);
  app.use("/api/inventory", inventory);
  app.use("/api/sales", sales);
  app.use("/api/expenses", expenses);
  app.use("/api/attachments", attachments);
  app.use("/api/categories", categories);
  app.use("/api/suppliers", suppliers);
  app.use("/api/warehouses", warehouses);
  app.use("/api/interest-levels", interestLevels);
  app.use("/api/interest-channels", interestChannels);
  app.use("/api/interests", interests);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
