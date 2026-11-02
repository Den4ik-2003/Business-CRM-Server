import { toCents, fromCents } from "../shared/pricing.js";

// Decimal128 з Mongo → рядок "12.50"; рядок/число → нормалізований рядок з 2 знаками
export const dec = (v) => (v === null || v === undefined ? null : v.toString());
export const money = (v) => {
  const c = toCents(v);
  return c === null ? null : fromCents(c);
};
