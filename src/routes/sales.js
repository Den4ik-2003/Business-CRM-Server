import { Router } from "express";
import { z } from "zod";
import { Product, Sale, Expense } from "../models/index.js";
import { wrap } from "../lib/errors.js";
import { canWrite } from "../middleware/auth.js";
import { applyMovement } from "../services/inventory.js";
import { dec } from "../lib/money.js";
const r = Router();
const oid = z.string().regex(/^[a-f\d]{24}$/i);
const STATUSES = ["new","shipped","at_branch","collected","refused"];
const serialize = s => ({ id:String(s._id), items:s.items.map(i=>({product:i.product?._id?{id:String(i.product._id),name:i.product.name,sku:i.product.sku}:{id:String(i.product)},quantity:i.quantity,unitPrice:dec(i.unitPrice),unitCost:dec(i.unitCost),total:dec(i.total)})),total:dec(s.total),currency:s.currency,date:s.date,note:s.note||"",status:s.status,channel:s.channel||"Інший",shippedAt:s.shippedAt||null,reminderAt:s.reminderAt||null,reminderCount:s.reminderCount||0,stockDeducted:!!s.stockDeducted, user:s.user?{id:String(s.user._id||s.user),name:s.user.name||""}:null, statusManuallySet:!!s.statusManuallySet });
async function markCollected(sale, user) {
 if (!sale.stockDeducted) {
   for (const item of sale.items) await applyMovement({productId:String(item.product),type:"sale",quantity:item.quantity,reason:"Замовлення отримано покупцем",comment:`Продаж ${sale._id}`,user,idempotencyKey:`sale-${sale._id}-${item.product}`});
   sale.stockDeducted=true;
 }
 sale.collectedAt=sale.collectedAt || new Date();
 sale.status="collected";
 sale.statusManuallySet=true;
 sale.reminderAt=null;
 await sale.save();
}
export async function processSaleTimers() {
 const now=new Date(), cutoff=new Date(now.getTime()-150*60*1000);
 const due=await Sale.find({status:"new",statusManuallySet:{$ne:true},date:{$lte:cutoff}});
 for(const s of due){s.status="shipped";s.shippedAt=now;s.reminderAt=new Date(now.getTime()+60*60*1000*60);await s.save();}
}
setInterval(()=>processSaleTimers().catch(e=>console.error("sale timer:",e.message)),60*1000).unref?.();

r.post("/",canWrite,wrap(async(req,res)=>{
 const d=z.object({items:z.array(z.object({productId:oid,quantity:z.coerce.number().int().positive(),unitPrice:z.coerce.number().nonnegative()})).min(1),date:z.coerce.date().optional(),note:z.string().max(1000).optional(),channel:z.string().trim().min(1).max(80).default("Інший")}).parse(req.body);
 const prepared=[];let total=0;
 for(const item of d.items){const p=await Product.findById(item.productId);if(!p||p.status==="archived")return res.status(400).json({error:"Товар не знайдено або архівний"});const unitCost=[p.costs?.purchasePrice,p.costs?.supplierShipping,p.costs?.customs,p.costs?.packaging,p.costs?.other].reduce((sum,v)=>sum+Number(dec(v)||0),0);const lineTotal=item.quantity*item.unitPrice;total+=lineTotal;prepared.push({product:p,quantity:item.quantity,unitPrice:item.unitPrice,unitCost,total:lineTotal});}
 const sale=await Sale.create({items:prepared.map(i=>({product:i.product._id,quantity:i.quantity,unitPrice:i.unitPrice,unitCost:i.unitCost,total:i.total})),total,date:d.date||new Date(),note:d.note,channel:d.channel,status:"new",user:req.user._id});
 await sale.populate("items.product","name sku");res.status(201).json({sale:serialize(sale)});
}));
r.patch("/:id/status",canWrite,wrap(async(req,res)=>{
 const d=z.object({status:z.enum(STATUSES)}).parse(req.body);
 if (!oid.safeParse(req.params.id).success) return res.status(400).json({error:"Некоректний номер продажу"});
 const sale = await Sale.findById(req.params.id);
 if (!sale || (req.user.role !== "owner" && String(sale.user) !== String(req.user._id))) {
   return res.status(404).json({error:"Продаж не знайдено або немає прав на його зміну"});
 }
 if (d.status === "collected") {
   await markCollected(sale, req.user);
 } else {
   const now = new Date();
   sale.status = d.status;
   sale.statusManuallySet = true;
   if (d.status === "shipped") {
     sale.shippedAt = now;
     sale.reminderAt = new Date(now.getTime() + 2 * 86400000);
   } else if (d.status === "at_branch") {
     sale.reminderAt = new Date(now.getTime() + 2 * 86400000);
   } else if (d.status === "refused" || d.status === "new") {
     sale.reminderAt = null;
   }
   await sale.save();
 }
 sale.statusManuallySet = true;
 await sale.save();
 await sale.populate("items.product","name sku");
 const result = serialize(sale);
 if (result.status !== d.status) {
   return res.status(409).json({error:"Статус не зберігся в базі даних. Оновіть сервер і спробуйте ще раз.", savedStatus:result.status});
 }
 res.json({sale:result});
}));
r.get("/notifications",wrap(async(req,res)=>{
 const now=new Date();const scope = req.user.role === "owner" ? {} : { user: req.user._id }; const due=await Sale.find({ ...scope, status:{$in:["shipped","at_branch"]},reminderAt:{$lte:now}}).sort({reminderAt:1}).limit(100).populate("items.product","name sku");
 for (const sale of due) { sale.reminderCount=(sale.reminderCount||0)+1; sale.reminderAt=new Date(now.getTime()+3*86400000); await sale.save(); }
 const reminders=due.map(sale=>sale.toObject());
 const stale=new Date(now.getTime()-3*86400000);const out=await Product.find({status:{$ne:"archived"},"stock.onHand":0,outOfStockSince:{$lte:stale}}).select("name sku").limit(100).lean();
 res.json({reminders:reminders.map(s=>({id:String(s._id),status:s.status,channel:s.channel,items:s.items.map(i=>({name:i.product?.name||"Товар",quantity:i.quantity})),reminderCount:s.reminderCount||0})),outOfStock:out.map(p=>({id:String(p._id),name:p.name,sku:p.sku}))});
}));
r.post("/:id/remind",canWrite,wrap(async(req,res)=>{const s=await Sale.findById(req.params.id);if(!s || (req.user.role!=="owner" && String(s.user)!==String(req.user._id)))return res.status(404).json({error:"Продаж не знайдено"});s.reminderCount=(s.reminderCount||0)+1;s.reminderAt=new Date(Date.now()+3*86400000);await s.save();res.json({ok:true,reminderAt:s.reminderAt});}));
r.get("/",wrap(async(req,res)=>{const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||25));const filter=req.user.role === "owner" ? (req.query.userId ? { user: req.query.userId } : {}) : { user: req.user._id };if(req.query.from||req.query.to)filter.date={...(req.query.from&&{$gte:new Date(req.query.from)}),...(req.query.to&&{$lte:new Date(req.query.to)})};const [items,total]=await Promise.all([Sale.find(filter).sort({date:-1}).skip((page-1)*limit).limit(limit).populate("items.product","name sku").populate("user","name").lean(),Sale.countDocuments(filter)]);res.json({items:items.map(serialize),total,page,pages:Math.max(1,Math.ceil(total/limit))});}));
r.get("/analytics/summary",wrap(async(req,res)=>{const match={status:{$in:["collected","completed"]}};if(req.query.from||req.query.to)match.date={...(req.query.from&&{$gte:new Date(req.query.from)}),...(req.query.to&&{$lte:new Date(req.query.to)})};const [sales]=await Sale.aggregate([{$match:match},{$group:{_id:null,revenue:{$sum:{$toDouble:"$total"}},count:{$sum:1},cost:{$sum:{$sum:{$map:{input:"$items",as:"i",in:{$multiply:[{$toDouble:{$ifNull:["$$i.unitCost",0]}},"$$i.quantity"]}}}}}}}]);const [expenses]=await Expense.aggregate([{$match:match.date?{date:match.date}:{}} ,{$group:{_id:null,amount:{$sum:{$toDouble:"$amount"}}}}]);const channels=await Sale.aggregate([{$match:match},{$group:{_id:"$channel",revenue:{$sum:{$toDouble:"$total"}},count:{$sum:1}}},{$sort:{revenue:-1}}]);res.json({revenue:sales?.revenue||0,salesCount:sales?.count||0,costOfGoods:sales?.cost||0,expenses:expenses?.amount||0,estimatedProfit:(sales?.revenue||0)-(sales?.cost||0)-(expenses?.amount||0),channels});}));
export default r;
