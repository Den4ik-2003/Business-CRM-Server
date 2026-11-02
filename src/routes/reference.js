import { Router } from "express";
import { z } from "zod";
import { Category, Supplier, Warehouse, Product } from "../models/index.js";
import { AppError, wrap } from "../lib/errors.js";
import { canWrite, ownerOnly } from "../middleware/auth.js";

// Довідники: категорії, постачальники, склади. Читати можуть усі, змінювати — owner/manager, видаляти — owner.
function crud({ Model, schema, usedIn, label }) {
  const r = Router();
  const out = (d) => ({ ...d.toObject(), id: String(d._id), _id: undefined, __v: undefined });
  r.get("/", wrap(async (_q, res) => res.json({ items: (await Model.find().sort({ name: 1 })).map(out) })));
  r.post("/", canWrite, wrap(async (req, res) => res.status(201).json(out(await Model.create(schema.parse(req.body))))));
  r.put(
    "/:id",
    canWrite,
    wrap(async (req, res) => {
      const doc = await Model.findByIdAndUpdate(req.params.id, schema.parse(req.body), { new: true, runValidators: true });
      if (!doc) throw new AppError(404, `${label} не знайдено`);
      res.json(out(doc));
    })
  );
  r.delete(
    "/:id",
    ownerOnly,
    wrap(async (req, res) => {
      if (await Product.exists({ [usedIn]: req.params.id }))
        throw new AppError(409, `${label} використовується в товарах — спочатку змініть їх`);
      const doc = await Model.findByIdAndDelete(req.params.id);
      if (!doc) throw new AppError(404, `${label} не знайдено`);
      res.json({ ok: true });
    })
  );
  return r;
}

const id = z.string().regex(/^[a-f\d]{24}$/i).nullable().optional().or(z.literal("").transform(() => null));
const name = z.string().trim().min(1, "Вкажіть назву").max(120);
const opt = z.string().trim().max(300).optional();

export const categories = crud({ Model: Category, usedIn: "category", label: "Категорію", schema: z.object({ name, parent: id }) });
export const suppliers = crud({
  Model: Supplier, usedIn: "supplier", label: "Постачальника",
  schema: z.object({ name, contact: opt, phone: opt, email: opt, currency: z.string().length(3).optional(), avgLeadTimeDays: z.coerce.number().int().min(0).optional(), note: opt, active: z.boolean().optional() }),
});
export const warehouses = crud({ Model: Warehouse, usedIn: "warehouse", label: "Склад", schema: z.object({ name, address: opt, isDefault: z.boolean().optional() }) });
