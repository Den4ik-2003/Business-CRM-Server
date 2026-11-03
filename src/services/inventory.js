import { Product, InventoryMovement } from "../models/index.js";
import { movementEffect, computeUnitCost, fromCents } from "../shared/pricing.js";
import { AppError } from "../lib/errors.js";
import { withTx } from "../lib/tx.js";
import { dec } from "../lib/money.js";

export const COST_KEYS = ["purchasePrice", "supplierShipping", "customs", "packaging", "other"];

export const plainCosts = (costs = {}) =>
  Object.fromEntries(COST_KEYS.map((k) => [k, dec(costs?.[k])]));

export const productUnitCost = (product) => computeUnitCost(plainCosts(product.costs));

/**
 * Єдина точка зміни залишків. Виконується в межах переданої транзакції.
 * Кожна зміна = запис InventoryMovement із залишком до/після.
 * Повторне проведення з тим самим idempotencyKey повертає вже наявну операцію.
 */
export async function applyInSession(session, p) {
  if (p.idempotencyKey) {
    const existing = await InventoryMovement.findOne({ idempotencyKey: p.idempotencyKey }).session(session);
    if (existing) return { movement: existing, duplicate: true };
  }
  const product = await Product.findById(p.productId).session(session);
  if (!product) throw new AppError(404, "Товар не знайдено");

  const before = product.stock.onHand;
  const reservedBefore = product.stock.reserved;
  let eff;
  try {
    eff = movementEffect(p.type, p.quantity, { onHand: before, fromReservation: !!p.fromReservation });
  } catch (e) {
    throw new AppError(400, e.message);
  }
  const after = before + eff.dOnHand;
  const reservedAfter = reservedBefore + eff.dReserved;

  if (after < 0) throw new AppError(409, `Недостатньо товару на складі: фізичний залишок ${before}`);
  if (reservedAfter < 0) throw new AppError(409, `Не можна зняти з резерву більше, ніж зарезервовано (${reservedBefore})`);
  if (reservedAfter > after)
    throw new AppError(409, `Недостатньо доступного залишку: доступно ${before - reservedBefore}`);

  const set = { "stock.onHand": after, "stock.reserved": reservedAfter };
  if (after <= 0 && before > 0) set.outOfStockSince = new Date();
  if (after > 0) set.outOfStockSince = null;
  if (p.type === "sale") set.lastSaleAt = new Date();
  if (p.type === "purchase_receipt") set.lastPurchaseAt = new Date();
  await Product.updateOne({ _id: product._id }, { $set: set }, { session });

  const unitCost = p.unitCost ?? productUnitCost(product);
  const totalCost = unitCost === null || unitCost === undefined ? null : Math.abs(eff.dOnHand) * unitCost;

  const [movement] = await InventoryMovement.create(
    [
      {
        product: product._id,
        type: p.type,
        quantity: Number(p.quantity),
        delta: eff.dOnHand,
        reservedDelta: eff.dReserved,
        balanceBefore: before,
        balanceAfter: after,
        unitCost: fromCents(unitCost),
        totalCost: fromCents(totalCost),
        reason: p.reason,
        comment: p.comment,
        relatedOrder: p.relatedOrder || null,
        relatedPurchase: p.relatedPurchase || null,
        user: p.user?._id,
        idempotencyKey: p.idempotencyKey,
      },
    ],
    { session }
  );
  return { movement, duplicate: false };
}

export async function applyMovement(params) {
  try {
    return await withTx((session) => applyInSession(session, params));
  } catch (e) {
    // гонка двох однакових запитів: другий впаде на унікальному індексі — повертаємо першу операцію
    if (e?.code === 11000 && params.idempotencyKey) {
      const movement = await InventoryMovement.findOne({ idempotencyKey: params.idempotencyKey });
      if (movement) return { movement, duplicate: true };
    }
    throw e;
  }
}

/** Середня кількість продажів на день за останні 30 днів за журналом руху. */
export async function salesRate(productId, createdAt, days = 30) {
  const since = new Date(Date.now() - days * 86400000);
  const [row] = await InventoryMovement.aggregate([
    { $match: { product: productId, type: "sale", createdAt: { $gte: since } } },
    { $group: { _id: null, sold: { $sum: "$quantity" } } },
  ]);
  const sold = row?.sold || 0;
  const ageDays = Math.max(1, Math.ceil((Date.now() - new Date(createdAt).getTime()) / 86400000));
  const windowDays = Math.min(days, ageDays);
  return { sold, windowDays, avgDaily: sold > 0 ? sold / windowDays : null };
}
