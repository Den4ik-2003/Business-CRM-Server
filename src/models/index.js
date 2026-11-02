import mongoose from "mongoose";
const { Schema, Types } = mongoose;
const D = Schema.Types.Decimal128;
const ref = (name, extra = {}) => ({ type: Schema.Types.ObjectId, ref: name, ...extra });
const make = (name, schema, opts = {}) =>
  mongoose.models[name] || mongoose.model(name, new Schema(schema, { timestamps: true, ...opts }));

export const User = make("User", {
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["owner", "manager", "viewer"], default: "viewer" },
  active: { type: Boolean, default: true },
});

export const Category = make("Category", {
  name: { type: String, required: true, trim: true },
  parent: ref("Category", { default: null }),
});
Category.schema.index({ name: 1, parent: 1 }, { unique: true });

export const Supplier = make("Supplier", {
  name: { type: String, required: true, unique: true, trim: true },
  contact: String,
  phone: String,
  email: String,
  currency: { type: String, default: "UAH" },
  avgLeadTimeDays: Number,
  note: String,
  active: { type: Boolean, default: true },
});

export const Warehouse = make("Warehouse", {
  name: { type: String, required: true, unique: true, trim: true },
  address: String,
  isDefault: { type: Boolean, default: false },
});

export const Attachment = make("Attachment", {
  entityType: { type: String, required: true },
  entityId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ["photo", "document"], default: "document" },
  originalName: String,
  storedName: String,
  external: { type: Boolean, default: false },
  url: String,
  mimeType: String,
  size: Number,
  uploadedBy: ref("User"),
});
Attachment.schema.index({ entityType: 1, entityId: 1 });

export const Product = make("Product", {
  name: { type: String, required: true, trim: true },
  sku: { type: String, required: true, unique: true, trim: true },
  barcode: { type: String, trim: true },
  category: ref("Category", { default: null }),
  subcategory: { type: String, trim: true },
  brand: { type: String, trim: true },
  supplier: ref("Supplier", { default: null }),
  description: String,
  images: { type: [String], default: [] },
  status: { type: String, enum: ["active", "inactive", "archived"], default: "active" },
  costs: {
    purchasePrice: D,
    supplierShipping: D,
    customs: D,
    packaging: D,
    other: D,
  },
  retailPrice: D,
  promoPrice: D,
  minPrice: D,
  stock: {
    // onHand і reserved змінюються ЛИШЕ через складські операції (InventoryMovement)
    onHand: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    inTransit: { type: Number, default: 0 },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 0 },
    reorderQty: { type: Number, default: 0 },
    leadTimeDays: Number,
  },
  warehouse: ref("Warehouse", { default: null }),
  lastPurchaseAt: Date,
  lastSaleAt: Date,
});
Product.schema.index({ barcode: 1 }, { sparse: true });
Product.schema.index({ status: 1, category: 1 });
Product.schema.index({ supplier: 1 });
Product.schema.index({ name: 1 });
Product.schema.index({ updatedAt: -1 });

export const ProductPriceHistory = make(
  "ProductPriceHistory",
  {
    product: ref("Product", { required: true }),
    field: { type: String, required: true },
    oldValue: D,
    newValue: D,
    changedBy: ref("User"),
  },
  { collection: "product_price_history" }
);
ProductPriceHistory.schema.index({ product: 1, createdAt: -1 });

export const InventoryMovement = make(
  "InventoryMovement",
  {
    product: ref("Product", { required: true }),
    type: { type: String, required: true },
    quantity: { type: Number, required: true }, // як введено користувачем
    delta: { type: Number, required: true }, // зміна фізичного залишку
    reservedDelta: { type: Number, default: 0 }, // зміна резерву
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    unitCost: D, // собівартість одиниці на момент операції
    totalCost: D, // |delta| × unitCost
    reason: String,
    comment: String,
    relatedOrder: { type: Schema.Types.ObjectId, default: null }, // ref на Order з'явиться з модулем замовлень
    relatedPurchase: { type: Schema.Types.ObjectId, default: null },
    user: ref("User"),
    idempotencyKey: { type: String },
  },
  { collection: "inventory_movements" }
);
InventoryMovement.schema.index({ product: 1, createdAt: -1 });
InventoryMovement.schema.index({ type: 1, createdAt: -1 });
InventoryMovement.schema.index({ createdAt: -1 });
// Захист від повторного проведення тієї самої операції
InventoryMovement.schema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

export const AuditLog = make(
  "AuditLog",
  {
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, required: true },
    changes: Schema.Types.Mixed,
    user: ref("User"),
  },
  { collection: "audit_logs" }
);
AuditLog.schema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export const AppSetting = make("AppSetting", {
  key: { type: String, required: true, unique: true },
  value: Schema.Types.Mixed,
});

export { Types };


export const Expense = make("Expense", {
  product: ref("Product", { default: null }),
  title: { type: String, required: true, trim: true },
  type: { type: String, enum: ["advertising", "shipping", "packaging", "purchase", "other"], default: "other" },
  amount: { type: D, required: true },
  currency: { type: String, default: "UAH" },
  date: { type: Date, default: Date.now },
  note: String,
  user: ref("User"),
}, { collection: "expenses" });
Expense.schema.index({ product: 1, date: -1 });
Expense.schema.index({ date: -1 });

export const Sale = make("Sale", {
  items: [{
    product: ref("Product", { required: true }),
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: D, required: true },
    unitCost: D,
    total: { type: D, required: true },
  }],
  total: { type: D, required: true },
  currency: { type: String, default: "UAH" },
  date: { type: Date, default: Date.now },
  note: String,
  status: { type: String, enum: ["completed", "cancelled"], default: "completed" },
  user: ref("User"),
}, { collection: "sales" });
Sale.schema.index({ date: -1 });
