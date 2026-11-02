// Єдине джерело правди для розрахунків собівартості й маржі.
// Використовується і сервером, і клієнтом. Усі суми рахуються в копійках (цілі числа),
// щоб уникнути помилок округлення чисел з плаваючою комою.

export const toCents = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
};

export const fromCents = (c) => (c === null || c === undefined ? null : (c / 100).toFixed(2));

const orZero = (v) => toCents(v) ?? 0;

/** Собівартість = закупівельна ціна + доставка + митні + пакування + інші прямі витрати. */
export function computeUnitCost(costs = {}) {
  const purchase = toCents(costs.purchasePrice);
  if (purchase === null) return null; // без закупівельної ціни собівартість невідома
  return (
    purchase +
    orZero(costs.supplierShipping) +
    orZero(costs.customs) +
    orZero(costs.packaging) +
    orZero(costs.other)
  );
}

const pct = (num, den) => Math.round((num / den) * 10000) / 100;

/**
 * Показники з одиниці товару. Якщо собівартість невідома або нульова —
 * відсотки НЕ рахуються (повертається null і причина), щоб не показувати оманливі числа.
 */
export function computeMetrics({ costs, retailPrice }) {
  const cost = computeUnitCost(costs);
  const price = toCents(retailPrice);
  const out = {
    unitCost: fromCents(cost),
    markupPct: null,
    marginPct: null,
    marginAmount: null,
    expectedProfit: null,
    note: null,
  };
  if (cost === null || cost <= 0) {
    out.note = "Собівартість не заповнена — націнка й маржа не розраховуються";
    return out;
  }
  if (price === null || price <= 0) {
    out.note = "Роздрібна ціна не вказана";
    return out;
  }
  const diff = price - cost;
  out.marginAmount = fromCents(diff);
  out.expectedProfit = fromCents(diff); // очікуваний; фактичний залежить від реклами, доставки, комісій, повернень
  out.markupPct = pct(diff, cost);
  out.marginPct = pct(diff, price);
  if (diff < 0) out.note = "Ціна продажу нижча за собівартість";
  return out;
}

/** Доступний залишок = фізичний − зарезервований. */
export const availableStock = (onHand = 0, reserved = 0) => onHand - reserved;

/** Днів запасу. Без продажів — null (в інтерфейсі «Недостатньо даних»), без ділення на нуль. */
export function daysOfStock(available, avgDailySales) {
  if (!avgDailySales || avgDailySales <= 0) return null;
  if (available <= 0) return 0;
  return Math.round((available / avgDailySales) * 10) / 10;
}

export const MOVEMENT_TYPES = {
  initial: "Початковий залишок",
  purchase_receipt: "Надходження від постачальника",
  sale: "Продаж",
  reserve: "Резервування під замовлення",
  reserve_cancel: "Скасування резерву",
  customer_return: "Повернення від покупця",
  damage: "Списання браку",
  loss: "Втрата товару",
  adjustment: "Ручне коригування",
  stocktake: "Інвентаризація",
  supplier_return: "Повернення постачальнику",
};
// Переміщення між складами додам разом з warehouse_stock на наступному етапі.

/**
 * Вплив операції на залишки. quantity для adjustment — зі знаком, для stocktake — підрахована кількість,
 * для решти — додатна.
 * Повертає { dOnHand, dReserved } або кидає Error з повідомленням.
 */
export function movementEffect(type, quantity, { onHand = 0, fromReservation = false } = {}) {
  const q = Number(quantity);
  if (!Number.isInteger(q)) throw new Error("Кількість має бути цілим числом");
  if (type === "adjustment") {
    if (q === 0) throw new Error("Коригування не може бути нульовим");
    return { dOnHand: q, dReserved: 0 };
  }
  if (type === "stocktake") {
    if (q < 0) throw new Error("Підрахована кількість не може бути від'ємною");
    return { dOnHand: q - onHand, dReserved: 0 };
  }
  if (q <= 0) throw new Error("Кількість має бути більшою за нуль");
  switch (type) {
    case "initial":
    case "purchase_receipt":
    case "customer_return":
      return { dOnHand: q, dReserved: 0 };
    case "sale":
      // Якщо товар було зарезервовано, продаж знімає резерв — так товар не списується двічі.
      return { dOnHand: -q, dReserved: fromReservation ? -q : 0 };
    case "damage":
    case "loss":
    case "supplier_return":
      return { dOnHand: -q, dReserved: 0 };
    case "reserve":
      return { dOnHand: 0, dReserved: q };
    case "reserve_cancel":
      return { dOnHand: 0, dReserved: -q };
    default:
      throw new Error(`Невідомий тип операції: ${type}`);
  }
}
