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
const ser = (a) => ({ id: String(a._id), kind: a.kind, name: a.originalName, mimeType: a.mimeType, size: a.size, at: a.createdAt, url: `/api/attachments/${a._id}/file` });

r.get("/", wrap(async (req, res) => {
  const q = z.object({ entityType: z.literal("product"), entityId: z.string().regex(/^[a-f\d]{24}$/i) }).parse(req.query);
  res.json({ items: (await Attachment.find(q).sort({ createdAt: -1 })).map(ser) });
}));

r.post("/", canWrite, upload.single("file"), wrap(async (req, res) => {
  const f = req.file;
  if (!f) throw new AppError(400, "Оберіть файл");
  try {
    const d = z.object({ entityType: z.literal("product"), entityId: z.string().regex(/^[a-f\d]{24}$/i), kind: z.enum(["photo", "document"]).default("document") }).parse(req.body);
    if (d.kind === "photo" && !f.mimetype.startsWith("image/")) throw new AppError(400, "Фото має бути зображенням");
    if (!(await Product.exists({ _id: d.entityId }))) throw new AppError(404, "Товар не знайдено");
    const a = await Attachment.create({ ...d, originalName: Buffer.from(f.originalname, "latin1").toString("utf8"), storedName: f.filename, mimeType: f.mimetype, size: f.size, uploadedBy: req.user._id });
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
  fs.promises.unlink(path.join(UPLOAD_DIR, a.storedName)).catch(() => {});
  res.json({ ok: true });
}));

export default r;
