import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { User } from "../models/index.js";
import { AppError } from "../lib/errors.js";

export const COOKIE = "bos_token";

export const signToken = (user) =>
  jwt.sign({ sub: String(user._id), sv: Number(user.tokenVersion || 0) }, config.jwtSecret, { expiresIn: "8h", issuer: "business-crm", audience: "business-crm-web" });

export const cookieOptions = {
  httpOnly: true,
  sameSite: config.crossSite ? "none" : "lax",
  secure: config.isProd || config.crossSite,
  maxAge: 8 * 3600 * 1000,
  path: "/",
};

export async function requireAuth(req, _res, next) {
  try {
    // Cookies are convenient for same-site deployments; Bearer also works when
    // mobile browsers block cross-site cookies or the frontend uses token auth.
    const authorization = req.get("authorization") || "";
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = req.cookies?.[COOKIE] || bearer;
    if (!token) throw new AppError(401, "Потрібно увійти в систему");
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { issuer: "business-crm", audience: "business-crm-web", algorithms: ["HS256"] });
    } catch {
      throw new AppError(401, "Сесія недійсна, увійдіть знову");
    }
    if (typeof payload.sub !== "string" || !/^[a-f0-9]{24}$/i.test(payload.sub)) throw new AppError(401, "Сесія недійсна, увійдіть знову");
    const user = await User.findById(payload.sub).select("+tokenVersion");
    if (!user || !user.active || Number(user.tokenVersion || 0) !== Number(payload.sv || 0)) throw new AppError(401, "Користувача не знайдено або вимкнено");
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

// owner > manager > viewer
export const requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user.role) ? next() : next(new AppError(403, "Недостатньо прав для цієї дії"));

export const canWrite = requireRole("owner", "manager");
export const ownerOnly = requireRole("owner");
