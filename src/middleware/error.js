import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";

export function notFound(_req, _res, next) {
  next(new AppError(404, "Маршрут не знайдено"));
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Перевірте введені дані",
      details: err.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || "поле";
    return res.status(409).json({ error: `Запис із таким значенням уже існує (${field})` });
  }
  if (err?.name === "CastError") return res.status(400).json({ error: "Некоректний ідентифікатор" });
  if (err?.name === "MulterError") return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Внутрішня помилка сервера" });
}
