import { Router } from "express";
import { z } from "zod";
import { Expense, Product } from "../models/index.js";
import { wrap } from "../lib/errors.js";
import { canWrite } from "../middleware/auth.js";
import { dec } from "../lib/money.js";
const r = Router();
const oid = z.string().regex(/^[a-f\d]{24}$/i);
const serialize = e => ({ id: String(e._id), product: e.product?._id ? { id: String(e.product._id), name: e.product.name, sku: e.product.sku } : null, title: e.title, type: e.type, amount: dec(e.amount), currency: e.currency, date: e.date, note: e.note || "", user: e.user?.name || null });
r.post("/", canWrite, wrap(async (req, res) => {
 const d = z.object({ productId: oid.nullable().optional(), title: z.string().trim().min(1).max(200), type: z.enum(["advertising","shipping","packaging","purchase","other"]).default("other"), amount: z.coerce.number().positive(), currency: z.string().length(3).default("UAH"), date: z.coerce.date().optional(), note: z.string().max(1000).optional() }).parse(req.body);
 if (d.productId && !await Product.exists({ _id: d.productId })) return res.status(400).json({ error: "Товар не знайдено" });
 const expense = await Expense.create({ product: d.productId || null, title: d.title, type: d.type, amount: d.amount, currency: d.currency.toUpperCase(), date: d.date || new Date(), note: d.note, user: req.user._id });
 await expense.populate("product", "name sku"); await expense.populate("user", "name");
 res.status(201).json({ expense: serialize(expense) });
}));
r.get("/", wrap(async (req, res) => {
 const filter = {};
 if (req.query.product) filter.product = req.query.product;
 if (req.query.type) filter.type = req.query.type;
 if (req.query.from || req.query.to) filter.date = { ...(req.query.from && { $gte: new Date(req.query.from) }), ...(req.query.to && { $lte: new Date(req.query.to) }) };
 const items = await Expense.find(filter).sort({ date: -1 }).limit(Math.min(500, Math.max(1, Number(req.query.limit) || 100))).populate("product", "name sku").populate("user", "name").lean();
 res.json({ items: items.map(serialize) });
}));
r.delete("/:id", canWrite, wrap(async (req, res) => { const result = await Expense.findByIdAndDelete(req.params.id); if (!result) return res.status(404).json({ error: "Витрату не знайдено" }); res.json({ ok: true }); }));
export default r;
