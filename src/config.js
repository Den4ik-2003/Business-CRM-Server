const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Не задано змінну середовища ${k} (див. .env.example)`);
  return v;
};
const isProd = process.env.NODE_ENV === "production";
export const config = {
  mongoUri: need("MONGODB_URI"),
  jwtSecret: need("JWT_SECRET"),
  port: Number(process.env.PORT || 4000),
  // Адреси фронтенду для CORS, через кому. Не потрібно, якщо фронтенд проксує /api на цей сервер.
  clientOrigins: (process.env.CLIENT_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean),
  // true — фронтенд і API на різних доменах без проксі (cookie SameSite=None; Secure)
  crossSite: process.env.CROSS_SITE === "true",
  isProd,
  uploadDir: process.env.UPLOAD_DIR || "uploads",
};
if (isProd && config.jwtSecret.length < 32) throw new Error("JWT_SECRET має бути не коротшим за 32 символи");
