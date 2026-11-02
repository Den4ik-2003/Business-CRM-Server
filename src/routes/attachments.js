import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { Attachment, Product } from "../models/index.js";
import { AppError, wrap } from "../lib/errors.js";
import { canWrite } from "../middleware/auth.js";

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain", "text/csv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_q, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase().slice(0, 8)),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_q, f, cb) => (ALLOWED.has(f.mimetype) ? cb(null, true) : cb(new AppError(400, "Непідтримуваний тип файлу (дозволено: JPG, PNG, WEBP, PDF, TXT, CSV, DOCX, XLSX)"))),
});

const r = Router();
const ser = (a) => ({
  id: String(a._id), kind: a.kind, name: a.originalName, mimeType: a.mimeType,
  size: a.size, at: a.createdAt,
  // Для зовнішніх зображень повертаємо URL Cloudinary, для локальних — endpoint файлу.
  url: a.external && a.url ? a.url : `/api/attachments/${a._id}/file`,
});

r.get("/", wrap(async (req, res) => {
  const q = z.object({ entityType: z.literal("product"), entityId: z.string().regex(/^[a-f\d]{24}$/i) }).parse(req.query);
  res.json({ items: (await Attachment.find(q).sort({ createdAt: -1 })).map(ser) });
}));

r.post("/", canWrite, upload.single("file"), wrap(async (req, res) => {
  const f = req.file;
  const base = z.object({
    entityType: z.literal("product"),
    entityId: z.string().regex(/^[a-f\d]{24}$/i),
    kind: z.enum(["photo", "document"]).default("document"),
  }).parse(req.body);

  if (!(await Product.exists({ _id: base.entityId }))) throw new AppError(404, "Товар не знайдено");

  // Cloudinary-фото вже завантажене за URL: не вимагати повторного вибору локального файлу.
  if (req.body.external === true || req.body.external === "true") {
    const d = z.object({ url: z.string().url(), name: z.string().trim().min(1).max(255).optional(), size: z.coerce.number().nonnegative().optional() }).parse(req.body);
    if (base.kind !== "photo") throw new AppError(400, "За посиланням можна додати лише фото");
    const a = await Attachment.create({
      ...base, external: true, url: d.url, originalName: d.name || "Зображення",
      mimeType: "image/*", size: d.size || 0, uploadedBy: req.user._id,
    });
    return res.status(201).json(ser(a));
  }

  if (!f) throw new AppError(400, "Оберіть файл");
  try {
    if (base.kind === "photo" && !f.mimetype.startsWith("image/")) throw new AppError(400, "Фото має бути зображенням");
    const a = await Attachment.create({ ...base, originalName: Buffer.from(f.originalname, "latin1").toString("utf8"), storedName: f.filename, mimeType: f.mimetype, size: f.size, uploadedBy: req.user._id });
    res.status(201).json(ser(a));
  } catch (e) {
    fs.promises.unlink(f.path).catch(() => {});
    throw e;
  }
}));

r.get("/:id/file", wrap(async (req, res) => {
  const a = await Attachment.findById(req.params.id);
  if (!a) throw new AppError(404, "Файл не знайдено");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(a.mimeType);
  res.sendFile(path.join(UPLOAD_DIR, a.storedName));
}));

r.delete("/:id", canWrite, wrap(async (req, res) => {
  const a = await Attachment.findByIdAndDelete(req.params.id);
  if (!a) throw new AppError(404, "Файл не знайдено");
  if (!a.external && a.storedName) fs.promises.unlink(path.join(UPLOAD_DIR, a.storedName)).catch(() => {});
  res.json({ ok: true });
}));

export default r;
