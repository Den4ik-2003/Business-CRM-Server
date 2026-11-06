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

function hasExpectedSignature(file) {
  const b = fs.readFileSync(file.path);
  const mime = file.mimetype;
  if (mime === "image/jpeg") return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/png") return b.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mime === "image/webp") return b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  if (mime === "application/pdf") return b.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  if (mime === "text/plain" || mime === "text/csv") return !b.includes(0) && !b.toString("utf8").includes("\uFFFD");
  return false;
}

const r = Router();
const ser = (a) => ({
  id: String(a._id), kind: a.kind, name: a.originalName, mimeType: a.mimeType,
  size: a.size, at: a.createdAt,
  // Для зовнішніх зображень повертаємо URL Cloudinary, для локальних — endpoint файлу.
  url: a.external && a.url ? a.url : `/api/attachments/${a._id}/file`,
});

r.get("/", wrap(async (req, res) => {
  const q = z.object({ entityType: z.literal("product"), entityId: z.string().regex(/^[a-f\d]{24}$/i) }).parse(req.query);
  res.json({ items: (await Attachment.find(q).sort({ createdAt: -1 }).limit(200)).map(ser) });
}));

r.post("/", canWrite, upload.single("file"), wrap(async (req, res) => {
  const f = req.file;
  try {
    const base = z.object({
      entityType: z.literal("product"),
      entityId: z.string().regex(/^[a-f\d]{24}$/i),
      kind: z.enum(["photo", "document"]).default("document"),
    }).parse(req.body);

    if (!(await Product.exists({ _id: base.entityId }))) throw new AppError(404, "Товар не знайдено");

    // Cloudinary-фото вже завантажене за URL: не вимагати повторного вибору локального файлу.
    if (req.body.external === true || req.body.external === "true") {
      if (f) throw new AppError(400, "Не надсилайте файл разом із зовнішнім посиланням");
      const d = z.object({ url: z.string().url().refine((u) => { try { const x = new URL(u); return x.protocol === "https:" && (x.hostname === "res.cloudinary.com" || x.hostname.endsWith(".res.cloudinary.com")); } catch { return false; } }, "Дозволено лише HTTPS-посилання Cloudinary"), name: z.string().trim().min(1).max(255).optional(), size: z.coerce.number().nonnegative().optional() }).parse(req.body);
      if (base.kind !== "photo") throw new AppError(400, "За посиланням можна додати лише фото");
      const a = await Attachment.create({
        ...base, external: true, url: d.url, originalName: d.name || "Зображення",
        mimeType: "image/*", size: d.size || 0, uploadedBy: req.user._id,
      });
      return res.status(201).json(ser(a));
    }

    if (!f) throw new AppError(400, "Оберіть файл");
    if (base.kind === "photo" && !f.mimetype.startsWith("image/")) throw new AppError(400, "Фото має бути зображенням");
    if (!hasExpectedSignature(f)) throw new AppError(400, "Вміст файлу не відповідає заявленому типу");
    const a = await Attachment.create({ ...base, originalName: Buffer.from(f.originalname, "latin1").toString("utf8"), storedName: f.filename, mimeType: f.mimetype, size: f.size, uploadedBy: req.user._id });
    res.status(201).json(ser(a));
  } catch (e) {
    if (f?.path) fs.promises.unlink(f.path).catch(() => {});
    throw e;
  }
}));

r.get("/:id/file", wrap(async (req, res) => {
  const a = await Attachment.findById(req.params.id);
  if (!a) throw new AppError(404, "Файл не знайдено");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(a.mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${String(a.originalName || "file").replace(/[\"\r\n]/g, "_")}"`);
  if (!a.storedName || path.basename(a.storedName) !== a.storedName) throw new AppError(404, "Файл не знайдено");
  res.sendFile(path.join(UPLOAD_DIR, a.storedName));
}));

r.delete("/:id", canWrite, wrap(async (req, res) => {
  const a = await Attachment.findByIdAndDelete(req.params.id);
  if (!a) throw new AppError(404, "Файл не знайдено");
  if (!a.external && a.storedName) fs.promises.unlink(path.join(UPLOAD_DIR, a.storedName)).catch(() => {});
  res.json({ ok: true });
}));

export default r;
