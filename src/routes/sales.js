import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Product, Sale, InventoryMovement } from "../models/index.js";
import { wrap } from "../lib/errors.js";
import { canWrite } from "../middleware/auth.js";
import { applyMovement } from "../services/inventory.js";
import { dec } from "../lib/money.js";
const r = Router();
const oid = z.string().regex(/^[a-f\d]{24}$/i);
const serialize = s => ({ id: String(s._id), items: s.items.map(i => ({ product: i.product?._id ? { id: String(i.product._id), name: i.product.name, sku: i.product.sku } : { id: String(i.product) }, quantity: i.quantity, unitPrice: dec(i.unitPrice), unitCost: dec(i.unitCost), total: dec(i.total) })), total: dec(s.total), currency: s.currency, date: s.date, note: s.note || "", status: s.status });
r.post("/", canWrite, wrap(async (req, res) => {
  const d = z.object({ items: z.array(z.object({ productId: oid, quantity: z.coerce.number().int().positive(), unitPrice: z.coerce.number().nonnegative() })).min(1), date: z.coerce.date().optional(), note: z.string().max(1000).optional() }).parse(req.body);
  const prepared = []; let total = 0;
  for (const item of d.items) {
    const p = await Product.findById(item.productId);
    if (!p || p.status === "archived") return res.status(400).json({ error: `Товар ${item.productId} не знайдено або архівний` });
    if (p.stock.onHand - p.stock.reserved < item.quantity) return res.status(400).json({ error: `Недостатньо залишку товару «${p.name}»` });
    const unitCost = [p.costs?.purchasePrice, p.costs?.supplierShipping, p.costs?.customs, p.costs?.packaging, p.costs?.other].reduce((sum, v) => sum + Number(dec(v) || 0), 0);
    const lineTotal = item.quantity * item.unitPrice; total += lineTotal;
    prepared.push({ product: p, quantity: item.quantity, unitPrice: item.unitPrice, unitCost, total: lineTotal });
  }
  // Кожна позиція проводиться через наявний журнал складських рухів.
  for (const item of prepared) await applyMovement({ productId: String(item.product._id), type: "sale", quantity: item.quantity, reason: "Продаж", comment: d.note || "", user: req.user });
  const sale = await Sale.create({ items: prepared.map(i => ({ product: i.product._id, quantity: i.quantity, unitPrice: i.unitPrice, unitCost: i.unitCost, total: i.total })), total, date: d.date || new Date(), note: d.note, user: req.user._id });
  await Promise.all(prepared.map(i => Product.updateOne({ _id: i.product._id }, { $set: { lastSaleAt: sale.date } })));
  await sale.populate("items.product", "name sku");
  res.status(201).json({ sale: serialize(sale) });
}));
r.get("/", wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const filter = {};
  if (req.query.from || req.query.to) filter.date = { ...(req.query.from && { $gte: new Date(req.query.from) }), ...(req.query.to && { $lte: new Date(req.query.to) }) };
  const [items, total] = await Promise.all([Sale.find(filter).sort({ date: -1 }).skip((page - 1) * limit).limit(limit).populate("items.product", "name sku").lean(), Sale.countDocuments(filter)]);
  res.json({ items: items.map(serialize), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));
r.get("/analytics/summary", wrap(async (req, res) => {
  const match = { status: "completed" };
  if (req.query.from || req.query.to) match.date = { ...(req.query.from && { $gte: new Date(req.query.from) }), ...(req.query.to && { $lte: new Date(req.query.to) }) };
  const [sales] = await Sale.aggregate([{ $match: match }, { $group: { _id: null, revenue: { $sum: { $toDouble: "$total" } }, count: { $sum: 1 }, cost: { $sum: { $sum: { $map: { input: "$items", as: "i", in: { $multiply: [{ $toDouble: { $ifNull: ["$$i.unitCost", 0] } }, "$$i.quantity"] } } } } } } }]);
  const [expenses] = await (await import("../models/index.js")).Expense.aggregate([{ $match: { ...(match.date ? { date: match.date } : {}) } }, { $group: { _id: null, amount: { $sum: { $toDouble: "$amount" } } } }]);
  res.json({ revenue: sales?.revenue || 0, salesCount: sales?.count || 0, costOfGoods: sales?.cost || 0, expenses: expenses?.amount || 0, estimatedProfit: (sales?.revenue || 0) - (sales?.cost || 0) - (expenses?.amount || 0) });
}));
export default r;
