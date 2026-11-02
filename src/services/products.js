import { z } from "zod";
import { computeMetrics, availableStock, daysOfStock, toCents } from "../shared/pricing.js";
import { dec, money } from "../lib/money.js";
import { AppError } from "../lib/errors.js";
import { COST_KEYS, plainCosts } from "./inventory.js";

const ref = (v) => (v && v._id ? { id: String(v._id), name: v.name } : v ? { id: String(v), name: null } : null);

export function serializeProduct(p) {
  const costs = plainCosts(p.costs);
  const retailPrice = dec(p.retailPrice);
  const s = p.stock || {};
  return {
    id: String(p._id),
    name: p.name,
    sku: p.sku,
    barcode: p.barcode || "",
    category: ref(p.category),
    subcategory: p.subcategory || "",
    brand: p.brand || "",
    supplier: ref(p.supplier),
    warehouse: ref(p.warehouse),
    description: p.description || "",
    images: Array.isArray(p.images) ? p.images : [],
    status: p.status,
    costs,
    retailPrice,
    promoPrice: dec(p.promoPrice),
    minPrice: dec(p.minPrice),
    metrics: computeMetrics({ costs, retailPrice }),
    stock: {
      onHand: s.onHand ?? 0,
      reserved: s.reserved ?? 0,
      available: availableStock(s.onHand ?? 0, s.reserved ?? 0),
      inTransit: s.inTransit ?? 0,
      min: s.min ?? 0,
      max: s.max ?? 0,
      reorderQty: s.reorderQty ?? 0,
      leadTimeDays: s.leadTimeDays ?? null,
    },
    lastPurchaseAt: p.lastPurchaseAt || null,
    lastSaleAt: p.lastSaleAt || null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function stockAnalytics(product, rate) {
  const available = availableStock(product.stock.onHand, product.stock.reserved);
  const days = daysOfStock(available, rate.avgDaily);
  const unitCost = toCents(product.metrics.unitCost);
  const price = toCents(product.retailPrice);
  const onHand = product.stock.onHand;
  return {
    avgDailySales: rate.avgDaily === null ? null : Math.round(rate.avgDaily * 100) / 100,
    soldInWindow: rate.sold,
    windowDays: rate.windowDays,
    daysOfStock: days, // null → «Недостатньо даних»
    stockoutDate: days === null ? null : new Date(Date.now() + days * 86400000).toISOString(),
    stockValueCost: unitCost && unitCost > 0 ? ((unitCost * onHand) / 100).toFixed(2) : null,
    stockValueRetail: price && price > 0 ? ((price * onHand) / 100).toFixed(2) : null,
  };
}

// ---------- валідація ----------
const moneyField = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v == null || (toCents(v) !== null && toCents(v) >= 0), "Некоректна сума")
  .transform((v) => (v == null ? v : money(v)));
const intField = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === "" || v === null ? undefined : v))
  .pipe(z.coerce.number().int("Ціле число").min(0, "Не менше нуля").optional());
const idField = z.string().regex(/^[a-f\d]{24}$/i, "Некоректний ідентифікатор").nullable().optional().or(z.literal("").transform(() => null));
const text = (max) => z.string().trim().max(max).optional();

export const productSchema = z.object({
  name: z.string().trim().min(1, "Вкажіть назву").max(200),
  sku: z.string().trim().min(1, "Вкажіть SKU").max(64),
  barcode: text(64),
  category: idField,
  subcategory: text(100),
  brand: text(100),
  supplier: idField,
  warehouse: idField,
  description: text(5000),
  images: z.array(z.string().url()).max(20).optional(),
  status: z.enum(["active", "inactive", "archived"]).optional(),
  costs: z.object(Object.fromEntries(COST_KEYS.map((k) => [k, moneyField]))).partial().optional(),
  retailPrice: moneyField,
  promoPrice: moneyField,
  minPrice: moneyField,
  stock: z
    .object({ min: intField, max: intField, reorderQty: intField, inTransit: intField, leadTimeDays: intField })
    .partial()
    .optional(),
  initialStock: intField, // лише при створенні; створює складську операцію «Початковий залишок»
});
export const productUpdateSchema = productSchema.partial();

export function validatePrices({ retailPrice, promoPrice, minPrice }) {
  const r = toCents(retailPrice), pr = toCents(promoPrice), mn = toCents(minPrice);
  if (r !== null && mn !== null && mn > r) throw new AppError(400, "Мінімальна ціна не може перевищувати роздрібну");
  if (pr !== null && mn !== null && pr < mn) throw new AppError(400, "Акційна ціна нижча за мінімально допустиму");
}
export function validateStockLimits(stock = {}) {
  if (stock.max && stock.min && stock.max < stock.min)
    throw new AppError(400, "Максимальний залишок не може бути меншим за мінімальний");
}
