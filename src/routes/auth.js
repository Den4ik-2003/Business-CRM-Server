import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/index.js";
import { AppError, wrap } from "../lib/errors.js";
import { COOKIE, cookieOptions, signToken, requireAuth } from "../middleware/auth.js";

const r = Router();
const pub = (u) => ({ id: String(u._id), email: u.email, name: u.name, role: u.role });

// Проста обмежувальна пам'ять від підбору паролів: 10 невдалих спроб / 15 хв на email+ip
const fails = new Map();
const key = (req, email) => `${req.ip}|${email}`;

r.post(
  "/login",
  wrap(async (req, res) => {
    const { email, password } = z.object({ email: z.string().email("Некоректний email"), password: z.string().min(1) }).parse(req.body);
    const k = key(req, email.toLowerCase());
    const f = fails.get(k);
    if (f && f.count >= 10 && Date.now() - f.at < 15 * 60000)
      throw new AppError(429, "Забагато невдалих спроб. Спробуйте за 15 хвилин");
    const user = await User.findOne({ email: email.toLowerCase() });
    const ok = user && user.active && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) {
      fails.set(k, { count: (f && Date.now() - f.at < 15 * 60000 ? f.count : 0) + 1, at: Date.now() });
      throw new AppError(401, "Невірний email або пароль");
    }
    fails.delete(k);
    res.cookie(COOKIE, signToken(user), cookieOptions).json({ user: pub(user) });
  })
);

r.post("/logout", (_req, res) => res.clearCookie(COOKIE).json({ ok: true }));
r.get("/me", requireAuth, (req, res) => res.json({ user: pub(req.user) }));

export default r;
