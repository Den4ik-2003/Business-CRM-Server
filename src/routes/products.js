import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Product, InventoryMovement, AuditLog, ProductPriceHistory, Attachment } from "../models/index.js";
import { AppError, wrap } from "../lib/errors.js";
import { canWrite, ownerOnly } from "../middleware/auth.js";
import { withTx } from "../lib/tx.js";
import { dec, money } from "../lib/money.js";
import { toCents } from "../shared/pricing.js";
import { audit } from "../services/audit.js";
import { applyInSession, salesRate, COST_KEYS, plainCosts } from "../services/inventory.js";
import {
  productSchema, productUpdateSchema, serializeProduct, stockAnalytics, validatePrices, validateStockLimits,
} from "../services/products.js";

const r = Router();
const POPULATE = [{ path: "category", select: "name" }, { path: "supplier", select: "name" }, { path: "warehouse", select: "name" }];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const D = (v) => mongoose.Types.Decimal128.fromString(money(v));

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "archived", "all"]).optional(),
  category: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  supplier: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  stock: z.enum(["in", "low", "out"]).optional(),
  priceMin: z.string().optional(),
  priceMax: z.string().optional(),
  sort: z.enum(["name", "sku", "retailPrice", "onHand", "updatedAt", "createdAt"]).default("updatedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const SORT = { name: "name", sku: "sku", retailPrice: "retailPrice", onHand: "stock.onHand", updatedAt: "updatedAt", createdAt: "createdAt" };
const AVAIL = { $subtract: ["$stock.onHand", "$stock.reserved"] };

export function buildFilter(q) {
  const and = [];
  if (q.status === "all") {} else if (q.status) and.push({ status: q.status });
  else and.push({ status: { $ne: "archived" } });
  if (q.q) {
    const rx = new RegExp(esc(q.q), "i");
    and.push({ $or: [{ name: rx }, { sku: rx }, { barcode: rx }, { brand: rx }] });
  }
  if (q.category) and.push({ category: q.category });
  if (q.supplier) and.push({ supplier: q.supplier });
  if (q.stock === "out") and.push({ $expr: { $lte: [AVAIL, 0] } });
  if (q.stock === "in") and.push({ $expr: { $gt: [AVAIL, 0] } });
  if (q.stock === "low") and.push({ $expr: { $and: [{ $gt: ["$stock.min", 0] }, { $gt: [AVAIL, 0] }, { $lt: [AVAIL, "$stock.min"] }] } });
  if (q.priceMin && toCents(q.priceMin) !== null) and.push({ retailPrice: { $gte: D(q.priceMin) } });
  if (q.priceMax && toCents(q.priceMax) !== null) and.push({ retailPrice: { $lte: D(q.priceMax) } });
  return and.length ? { $and: and } : {};
}

r.get(
  "/",
  wrap(async (req, res) => {
    const q = listQuery.parse(req.query);
    const filter = buildFilter(q);
    const sort = { [SORT[q.sort]]: q.dir === "asc" ? 1 : -1, _id: 1 };
    const [total, docs] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).populate(POPULATE).lean(),
    ]);
    res.json({ items: docs.map(serializeProduct), total, page: q.page, pages: Math.max(1, Math.ceil(total / q.limit)) });
  })
);

r.get(
  "/:id",
  wrap(async (req, res) => {
    const doc = await Product.findById(req.params.id).populate(POPULATE).lean();
    if (!doc) throw new AppError(404, "Товар не знайдено");
    const product = serializeProduct(doc);
    const rate = await salesRate(doc._id, doc.createdAt);
    res.json({ product, analytics: stockAnalytics(product, rate) });
  })
);

r.post(
  "/",
  canWrite,
  wrap(async (req, res) => {
    const d = productSchema.parse(req.body);
    validatePrices(d);
    validateStockLimits(d.stock);
    const created = await withTx(async (session) => {
      const { initialStock, ...rest } = d;
      const [product] = await Product.create([{ ...rest, stock: { ...(rest.stock || {}), onHand: 0, reserved: 0 } }], { session });
      await audit(session, { entityType: "product", entityId: product._id, action: "create", changes: { name: d.name, sku: d.sku }, user: req.user });
      for (const k of ["retailPrice", "promoPrice", "minPrice"]) {
        if (d[k]) await ProductPriceHistory.create([{ product: product._id, field: k, oldValue: null, newValue: D(d[k]), changedBy: req.user._id }], { session });
      }
      if (initialStock > 0)
        await applyInSession(session, { productId: product._id, type: "initial", quantity: initialStock, reason: "Початковий залишок", user: req.user });
      return product._id;
    });
    const doc = await Product.findById(created).populate(POPULATE).lean();
    res.status(201).json(serializeProduct(doc));
  })
);

const PRICE_FIELDS = ["retailPrice", "promoPrice", "minPrice"];
const FLAT = ["name", "sku", "barcode", "category", "subcategory", "brand", "supplier", "warehouse", "description", "status"];

r.put(
  "/:id",
  canWrite,
  wrap(async (req, res) => {
    const d = productUpdateSchema.parse(req.body);
    delete d.initialStock; // залишок змінюється лише складськими операціями
    const out = await withTx(async (session) => {
      const doc = await Product.findById(req.params.id).session(session);
      if (!doc) throw new AppError(404, "Товар не знайдено");
      const before = { ...Object.fromEntries(FLAT.map((k) => [k, doc[k] == null ? null : String(doc[k])])), costs: plainCosts(doc.costs), ...Object.fromEntries(PRICE_FIELDS.map((k) => [k, dec(doc[k])])), stock: { min: doc.stock.min, max: doc.stock.max, reorderQty: doc.stock.reorderQty, inTransit: doc.stock.inTransit, leadTimeDays: doc.stock.leadTimeDays } };

      validatePrices({ retailPrice: d.retailPrice !== undefined ? d.retailPrice : dec(doc.retailPrice), promoPrice: d.promoPrice !== undefined ? d.promoPrice : dec(doc.promoPrice), minPrice: d.minPrice !== undefined ? d.minPrice : dec(doc.minPrice) });
      validateStockLimits({ ...before.stock, ...(d.stock || {}) });

      const changes = {};
      for (const k of FLAT) if (d[k] !== undefined) {
        const nv = d[k] === "" ? null : d[k];
        if ((before[k] ?? null) !== (nv === null ? null : String(nv))) { changes[k] = { from: before[k], to: nv }; doc.set(k, nv); }
      }
      for (const k of PRICE_FIELDS) if (d[k] !== undefined && toCents(d[k]) !== toCents(before[k])) {
        changes[k] = { from: before[k], to: d[k] };
        doc.set(k, d[k] === null ? null : D(d[k]));
        await ProductPriceHistory.create([{ product: doc._id, field: k, oldValue: before[k] === null ? null : D(before[k]), newValue: d[k] === null ? null : D(d[k]), changedBy: req.user._id }], { session });
      }
      for (const k of COST_KEYS) if (d.costs?.[k] !== undefined && toCents(d.costs[k]) !== toCents(before.costs[k])) {
        changes[`costs.${k}`] = { from: before.costs[k], to: d.costs[k] };
        doc.set(`costs.${k}`, d.costs[k] === null ? null : D(d.costs[k]));
        await ProductPriceHistory.create([{ product: doc._id, field: `costs.${k}`, oldValue: before.costs[k] === null ? null : D(before.costs[k]), newValue: d.costs[k] === null ? null : D(d.costs[k]), changedBy: req.user._id }], { session });
      }
      for (const k of Object.keys(d.stock || {})) if (d.stock[k] !== undefined && d.stock[k] !== before.stock[k]) {
        changes[`stock.${k}`] = { from: before.stock[k], to: d.stock[k] };
        doc.set(`stock.${k}`, d.stock[k]);
      }
      if (Object.keys(changes).length) {
        await doc.save({ session });
        await audit(session, { entityType: "product", entityId: doc._id, action: "update", changes, user: req.user });
      }
      return doc._id;
    });
    res.json(serializeProduct(await Product.findById(out).populate(POPULATE).lean()));
  })
);

const setStatus = (status, action) =>
  wrap(async (req, res) => {
    await withTx(async (session) => {
      const doc = await Product.findById(req.params.id).session(session);
      if (!doc) throw new AppError(404, "Товар не знайдено");
      const from = doc.status;
      if (from === status) return;
      doc.status = status;
      await doc.save({ session });
      await audit(session, { entityType: "product", entityId: doc._id, action, changes: { status: { from, to: status } }, user: req.user });
    });
    res.json(serializeProduct(await Product.findById(req.params.id).populate(POPULATE).lean()));
  });
r.post("/:id/archive", canWrite, setStatus("archived", "archive"));
r.post("/:id/restore", canWrite, setStatus("active", "restore"));

r.delete(
  "/:id",
  ownerOnly,
  wrap(async (req, res) => {
    // Видалити можна лише товар без руху (крім початкового залишку). Решту — архівувати, щоб не втратити історію.
    const used = await InventoryMovement.exists({ product: req.params.id, type: { $ne: "initial" } });
    if (used) throw new AppError(409, "У товару є історія складських операцій. Архівуйте його замість видалення");
    await withTx(async (session) => {
      const doc = await Product.findByIdAndDelete(req.params.id, { session });
      if (!doc) throw new AppError(404, "Товар не знайдено");
      await InventoryMovement.deleteMany({ product: doc._id }, { session });
      await audit(session, { entityType: "product", entityId: doc._id, action: "delete", changes: { name: doc.name, sku: doc.sku }, user: req.user });
    });
    res.json({ ok: true });
  })
);

r.get(
  "/:id/history",
  wrap(async (req, res) => {
    const [audits, prices] = await Promise.all([
      AuditLog.find({ entityType: "product", entityId: req.params.id }).sort({ createdAt: -1 }).limit(200).populate("user", "name").lean(),
      ProductPriceHistory.find({ product: req.params.id }).sort({ createdAt: -1 }).limit(200).populate("changedBy", "name").lean(),
    ]);
    res.json({
      audit: audits.map((a) => ({ id: String(a._id), action: a.action, changes: a.changes, user: a.user?.name || null, at: a.createdAt })),
      prices: prices.map((p) => ({ id: String(p._id), field: p.field, from: dec(p.oldValue), to: dec(p.newValue), user: p.changedBy?.name || null, at: p.createdAt })),
    });
  })
);

export default r;
