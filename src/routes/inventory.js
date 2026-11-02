import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { InventoryMovement, Product } from "../models/index.js";
import { wrap } from "../lib/errors.js";
import { canWrite } from "../middleware/auth.js";
import { dec } from "../lib/money.js";
import { applyMovement } from "../services/inventory.js";
import { serializeProduct } from "../services/products.js";
import { MOVEMENT_TYPES } from "../shared/pricing.js";

const r = Router();
const oid = z.string().regex(/^[a-f\d]{24}$/i, "Некоректний ідентифікатор");

const ser = (m) => ({
  id: String(m._id),
  product: m.product?._id ? { id: String(m.product._id), name: m.product.name, sku: m.product.sku } : { id: String(m.product) },
  type: m.type,
  typeLabel: MOVEMENT_TYPES[m.type] || m.type,
  quantity: m.quantity,
  delta: m.delta,
  reservedDelta: m.reservedDelta,
  balanceBefore: m.balanceBefore,
  balanceAfter: m.balanceAfter,
  unitCost: dec(m.unitCost),
  totalCost: dec(m.totalCost),
  reason: m.reason || "",
  comment: m.comment || "",
  user: m.user?.name || null,
  at: m.createdAt,
});

r.post(
  "/movements",
  canWrite,
  wrap(async (req, res) => {
    const d = z
      .object({
        productId: oid,
        type: z.enum(Object.keys(MOVEMENT_TYPES)),
        quantity: z.coerce.number().int("Кількість — ціле число"),
        reason: z.string().trim().max(200).optional(),
        comment: z.string().trim().max(1000).optional(),
        fromReservation: z.boolean().optional(),
        // ключ генерує форма; повторна відправка тієї самої форми не проведе операцію вдруге
        idempotencyKey: z.string().min(8).max(100).optional(),
      })
      .parse(req.body);
    if (d.type === "initial") d.reason ||= "Початковий залишок";
    const { movement, duplicate } = await applyMovement({ ...d, user: req.user });
    const product = await Product.findById(d.productId).populate("category supplier warehouse", "name").lean();
    res.status(duplicate ? 200 : 201).json({ movement: ser(movement), duplicate, product: serializeProduct(product) });
  })
);

r.get(
  "/movements",
  wrap(async (req, res) => {
    const q = z
      .object({
        product: oid.optional(),
        type: z.string().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    const f = {};
    if (q.product) f.product = new mongoose.Types.ObjectId(q.product);
    if (q.type) f.type = q.type;
    if (q.from || q.to) f.createdAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    const [total, items] = await Promise.all([
      InventoryMovement.countDocuments(f),
      InventoryMovement.find(f).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate("product", "name sku").populate("user", "name").lean(),
    ]);
    res.json({ items: items.map(ser), total, page: q.page, pages: Math.max(1, Math.ceil(total / q.limit)) });
  })
);

// Сповіщення по складу. Кожен тип рахується окремим серверним запитом з ліміту 50 записів.
r.get(
  "/alerts",
  wrap(async (_req, res) => {
    const base = { status: { $ne: "archived" } };
    const AV = { $subtract: ["$stock.onHand", "$stock.reserved"] };
    const lim = 50;
    const stale = new Date(Date.now() - 90 * 86400000);
    const since = new Date(Date.now() - 30 * 86400000);
    const pick = (f) => Product.find({ ...base, ...f }).limit(lim).select("name sku stock lastSaleAt").lean();
    const [out, belowMin, excess, notSelling, sales, discrepancies] = await Promise.all([
      pick({ $expr: { $lte: [AV, 0] } }),
      pick({ $expr: { $and: [{ $gt: ["$stock.min", 0] }, { $gt: [AV, 0] }, { $lt: [AV, "$stock.min"] }] } }),
      pick({ $expr: { $and: [{ $gt: ["$stock.max", 0] }, { $gt: ["$stock.onHand", "$stock.max"] }] } }),
      pick({ "stock.onHand": { $gt: 0 }, $or: [{ lastSaleAt: { $lt: stale } }, { lastSaleAt: null, createdAt: { $lt: stale } }] }),
      InventoryMovement.aggregate([
        { $match: { type: "sale", createdAt: { $gte: since } } },
        { $group: { _id: "$product", sold: { $sum: "$quantity" } } },
      ]),
      InventoryMovement.find({ type: "stocktake", delta: { $ne: 0 }, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(lim).populate("product", "name sku").lean(),
    ]);
    // «Закінчується»: запасу вистачить менш ніж на 14 днів за середніми продажами 30 днів
    const soldBy = new Map(sales.map((s) => [String(s._id), s.sold]));
    const candidates = soldBy.size
      ? await Product.find({ ...base, _id: { $in: [...soldBy.keys()] }, "stock.onHand": { $gt: 0 } }).select("name sku stock").lean()
      : [];
    const runningOut = candidates
      .map((p) => ({ p, days: (p.stock.onHand - p.stock.reserved) / (soldBy.get(String(p._id)) / 30) }))
      .filter((x) => x.days > 0 && x.days <= 14)
      .sort((a, b) => a.days - b.days)
      .slice(0, lim);
    const short = (p, extra = {}) => ({ id: String(p._id), name: p.name, sku: p.sku, onHand: p.stock?.onHand, available: p.stock ? p.stock.onHand - p.stock.reserved : undefined, min: p.stock?.min, max: p.stock?.max, ...extra });
    res.json({
      outOfStock: out.map((p) => short(p)),
      belowMin: belowMin.map((p) => short(p)),
      runningOut: runningOut.map(({ p, days }) => short(p, { daysLeft: Math.round(days * 10) / 10 })),
      excess: excess.map((p) => short(p)),
      notSelling: notSelling.map((p) => short(p, { lastSaleAt: p.lastSaleAt })),
      discrepancies: discrepancies.map((m) => ({ id: String(m._id), product: m.product ? { id: String(m.product._id), name: m.product.name, sku: m.product.sku } : null, delta: m.delta, at: m.createdAt })),
    });
  })
);

export default r;
