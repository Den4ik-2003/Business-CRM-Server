import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/index.js";
import { AppError, wrap } from "../lib/errors.js";

const r = Router(); // доступ лише власнику (підключено в app.js)
const pub = (u) => ({ id: String(u._id), email: u.email, name: u.name, role: u.role, active: u.active, approvalStatus: u.approvalStatus || "approved" });
const role = z.enum(["owner", "manager", "viewer"]);

r.get("/", wrap(async (_q, res) => res.json({ items: (await User.find().sort({ createdAt: 1 })).map(pub) })));
r.get("/pending", wrap(async (_q, res) => res.json({ items: (await User.find({ approvalStatus: "pending" }).sort({ createdAt: 1 })).map(pub) })));
r.patch("/:id/approval", wrap(async (req, res) => {
  const d = z.object({ decision: z.enum(["approve", "reject"]) }).parse(req.body);
  const user = await User.findById(req.params.id).select("+tokenVersion");
  if (!user) throw new AppError(404, "Користувача не знайдено");
  if (user.role === "owner") throw new AppError(400, "Не можна змінювати доступ власника");
  user.approvalStatus = d.decision === "approve" ? "approved" : "rejected";
  user.active = d.decision === "approve";
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  res.json(pub(user));
}));

r.post(
  "/",
  wrap(async (req, res) => {
    const d = z
      .object({ email: z.string().email(), name: z.string().trim().min(1), password: z.string().min(12, "Пароль має містити щонайменше 12 символів").max(128), role })
      .parse(req.body);
    const user = await User.create({ ...d, passwordHash: await bcrypt.hash(d.password, 12) });
    res.status(201).json(pub(user));
  })
);

r.delete("/:id", wrap(async (req, res) => {
  const user = await User.findById(req.params.id).select("+tokenVersion");
  if (!user) throw new AppError(404, "Користувача не знайдено");
  if (user.role === "owner") throw new AppError(400, "Обліковий запис адміністратора видалити не можна");
  if (String(user._id) === String(req.user._id)) throw new AppError(400, "Не можна видалити власний обліковий запис");
  await user.deleteOne();
  res.json({ ok: true });
}));

r.patch(
  "/:id",
  wrap(async (req, res) => {
    const d = z.object({ name: z.string().trim().min(1), role, active: z.boolean(), password: z.string().min(12, "Пароль має містити щонайменше 12 символів").max(128) }).partial().parse(req.body);
    const user = await User.findById(req.params.id).select("+tokenVersion");
    if (!user) throw new AppError(404, "Користувача не знайдено");
    if (String(user._id) === String(req.user._id) && (d.active === false || (d.role && d.role !== "owner")))
      throw new AppError(400, "Не можна знизити власні права чи вимкнути себе");
    const roleChanged = Boolean(d.role && d.role !== user.role);
    if (d.name) user.name = d.name;
    if (d.role) user.role = d.role;
    if (d.active !== undefined) user.active = d.active;
    if (d.password) user.passwordHash = await bcrypt.hash(d.password, 12);
    if (d.password || d.active === false || roleChanged) user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    res.json(pub(user));
  })
);

export default r;
