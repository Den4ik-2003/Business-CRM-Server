import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/index.js";
import { AppError, wrap } from "../lib/errors.js";
import { COOKIE, cookieOptions, signToken, requireAuth } from "../middleware/auth.js";

const r = Router();
const pub = (u) => ({ id: String(u._id), email: u.email, name: u.name, role: u.role, approvalStatus: u.approvalStatus || "approved" });


r.post(
  "/login",
  wrap(async (req, res) => {
    const { email, password } = z.object({ email: z.string().email("Некоректний email").max(254), password: z.string().min(1).max(128) }).parse(req.body);
    const user = await User.findOne({ email: email.toLowerCase() }).select("+tokenVersion");
    const passwordOk = user && (await bcrypt.compare(password, user.passwordHash));
    if (passwordOk && user.approvalStatus === "pending") throw new AppError(403, "Вашу заявку ще не підтвердив адміністратор");
    if (passwordOk && user.approvalStatus === "rejected") throw new AppError(403, "Адміністратор відхилив вашу заявку на доступ");
    if (!passwordOk || !user.active) throw new AppError(401, "Невірний email або пароль");
    res.cookie(COOKIE, signToken(user), cookieOptions).json({ user: pub(user) });
  })
);


r.post("/register", wrap(async (req, res) => {
  const d = z.object({
    email: z.string().email("Некоректний email").transform(v => v.toLowerCase()),
    name: z.string().trim().min(2, "Вкажіть ім’я"),
    password: z.string().min(12, "Пароль має містити щонайменше 12 символів").max(128),
  }).parse(req.body);
  if (await User.exists({ email: d.email })) throw new AppError(409, "Користувач із таким email уже існує");
  const user = await User.create({
    ...d, role: "manager", active: false, approvalStatus: "pending",
    passwordHash: await bcrypt.hash(d.password, 12),
  });
  res.status(201).json({ ok: true, message: "Заявку надіслано адміністратору", user: pub(user) });
}));

r.post("/logout", requireAuth, wrap(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined }).json({ ok: true });
}));
r.get("/me", requireAuth, (req, res) => res.json({ user: pub(req.user) }));

export default r;
