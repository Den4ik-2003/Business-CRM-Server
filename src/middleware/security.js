import { AppError } from "../lib/errors.js";
import { config } from "../config.js";

// Small in-process limiter. For multi-instance production deployments use a shared Redis store.
const buckets = new Map();
export function rateLimit({ windowMs = 60_000, max = 120, message = "Забагато запитів. Спробуйте пізніше", keyGenerator } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyGenerator ? keyGenerator(req) : `${req.ip}:${req.baseUrl || ""}${req.path}`;
    let item = buckets.get(key);
    if (!item || now - item.start >= windowMs) item = { start: now, count: 0 };
    item.count += 1; buckets.set(key, item);
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.start >= windowMs) buckets.delete(k);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - item.count)));
    if (item.count > max) { res.setHeader("Retry-After", String(Math.ceil((item.start + windowMs - now) / 1000))); return next(new AppError(429, message)); }
    next();
  };
}

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  if (req.path.startsWith("/api/")) { res.setHeader("Cache-Control", "no-store, max-age=0"); res.setHeader("Pragma", "no-cache"); }
  if (config.isProd) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

export function csrfOriginGuard(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  // Cookie-authenticated browser writes must originate from the configured CRM origin.
  if (req.cookies?.bos_token) {
    const sameOrigin = origin && origin === `${req.protocol}://${req.get("host")}`;
    const configured = origin && config.clientOrigins.includes(origin);
    const localDev = origin && config.isProd === false && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!sameOrigin && !configured && !localDev) return next(new AppError(403, "Запит відхилено перевіркою джерела (CSRF)"));
  }
  next();
}
