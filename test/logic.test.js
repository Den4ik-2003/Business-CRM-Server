import { describe, it, expect } from "vitest";
import {
  toCents, computeUnitCost, computeMetrics, availableStock, daysOfStock, movementEffect,
} from "../src/shared/pricing.js";

describe("собівартість", () => {
  it("сумує всі складові", () => {
    expect(computeUnitCost({ purchasePrice: "100", supplierShipping: "10.50", customs: "5", packaging: "2.25", other: "0.25" })).toBe(11800);
  });
  it("не заповнені додаткові витрати = 0", () => {
    expect(computeUnitCost({ purchasePrice: "99.99" })).toBe(9999);
  });
  it("без закупівельної ціни — невідома", () => {
    expect(computeUnitCost({ supplierShipping: "10" })).toBeNull();
  });
  it("не губить копійки на 0.1 + 0.2", () => {
    expect(computeUnitCost({ purchasePrice: "0.1", other: "0.2" })).toBe(30);
  });
  it("приймає кому як десятковий роздільник", () => {
    expect(toCents("12,5")).toBe(1250);
  });
});

describe("націнка і маржа", () => {
  it("рахує за формулами з ТЗ", () => {
    const m = computeMetrics({ costs: { purchasePrice: "100" }, retailPrice: "150" });
    expect(m.markupPct).toBe(50); // (150-100)/100
    expect(m.marginPct).toBe(33.33); // (150-100)/150
    expect(m.marginAmount).toBe("50.00");
  });
  it("не показує відсотки при нульовій собівартості", () => {
    const m = computeMetrics({ costs: { purchasePrice: "0" }, retailPrice: "150" });
    expect(m.markupPct).toBeNull();
    expect(m.marginPct).toBeNull();
    expect(m.note).toBeTruthy();
  });
  it("не показує відсотки без собівартості", () => {
    expect(computeMetrics({ costs: {}, retailPrice: "150" }).marginPct).toBeNull();
  });
  it("не показує відсотки без ціни", () => {
    expect(computeMetrics({ costs: { purchasePrice: "10" }, retailPrice: null }).marginPct).toBeNull();
  });
  it("попереджає про збиткову ціну", () => {
    const m = computeMetrics({ costs: { purchasePrice: "100" }, retailPrice: "80" });
    expect(m.marginPct).toBe(-25);
    expect(m.note).toMatch(/нижча/);
  });
});

describe("залишки", () => {
  it("доступний = фізичний − резерв", () => expect(availableStock(10, 3)).toBe(7));
  it("дні запасу без продажів → null, без ділення на нуль", () => {
    expect(daysOfStock(10, null)).toBeNull();
    expect(daysOfStock(10, 0)).toBeNull();
  });
  it("дні запасу", () => expect(daysOfStock(30, 2)).toBe(15));
  it("нуль днів, якщо нічого не доступно", () => expect(daysOfStock(0, 2)).toBe(0));
});

describe("складські операції", () => {
  it("надходження збільшує залишок", () => expect(movementEffect("purchase_receipt", 5)).toEqual({ dOnHand: 5, dReserved: 0 }));
  it("резерв не змінює фізичний залишок", () => expect(movementEffect("reserve", 2)).toEqual({ dOnHand: 0, dReserved: 2 }));
  it("продаж із резерву знімає і залишок, і резерв (без подвійного списання)", () =>
    expect(movementEffect("sale", 2, { fromReservation: true })).toEqual({ dOnHand: -2, dReserved: -2 }));
  it("продаж без резерву не чіпає резерв", () => expect(movementEffect("sale", 2)).toEqual({ dOnHand: -2, dReserved: 0 }));
  it("інвентаризація ставить підраховану кількість", () => expect(movementEffect("stocktake", 7, { onHand: 10 })).toEqual({ dOnHand: -3, dReserved: 0 }));
  it("коригування приймає від'ємне значення", () => expect(movementEffect("adjustment", -4)).toEqual({ dOnHand: -4, dReserved: 0 }));
  it("відхиляє нульову та дробову кількість", () => {
    expect(() => movementEffect("loss", 0)).toThrow();
    expect(() => movementEffect("loss", 1.5)).toThrow();
    expect(() => movementEffect("adjustment", 0)).toThrow();
  });
  it("відхиляє невідомий тип", () => expect(() => movementEffect("magic", 1)).toThrow());
});
