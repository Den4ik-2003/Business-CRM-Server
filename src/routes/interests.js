import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { Product, ProductInterest, InterestLevel, InterestChannel } from "../models/index.js";
import { AppError, wrap } from "../lib/errors.js";
import { canWrite, ownerOnly } from "../middleware/auth.js";

const r = Router();
const id = z.string().regex(/^[a-f\d]{24}$/i);
const levelBody = z.object({ name: z.string().trim().min(1).max(120), weight: z.coerce.number().min(0).max(100) });
const channelBody = z.object({ name: z.string().trim().min(1).max(120) });
const out = d => ({ id: String(d._id), name: d.name, ...(d.weight !== undefined ? { weight: d.weight } : {}), active: d.active !== false });
const crud = (Model, schema, label) => {
  const x = Router();
  x.get("/", wrap(async (_q,res) => res.json({items:(await Model.find({active:true}).sort({name:1}).lean()).map(out)})));
  x.post("/", canWrite, wrap(async (req,res) => res.status(201).json(out(await Model.create(schema.parse(req.body))))));
  x.put("/:id", canWrite, wrap(async (req,res) => {
    const doc = await Model.findByIdAndUpdate(req.params.id, schema.parse(req.body), {new:true,runValidators:true});
    if (!doc) throw new AppError(404, `${label} не знайдено`);
    res.json(out(doc));
  }));
  x.delete("/:id", ownerOnly, wrap(async (req,res) => {
    const used = await ProductInterest.exists({ [Model === InterestLevel ? "level" : "channel"]: req.params.id });
    if (used) {
      const inactive = await Model.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
      if (!inactive) throw new AppError(404, `${label} не знайдено`);
      return res.json({ ok: true, deactivated: true });
    }
    const doc = await Model.findByIdAndDelete(req.params.id);
    if (!doc) throw new AppError(404, `${label} не знайдено`);
    res.json({ok:true});
  }));
  return x;
};
export const interestLevels = crud(InterestLevel, levelBody, "Рівень");
export const interestChannels = crud(InterestChannel, channelBody, "Канал");

const calcRating = async productId => {
  const rows = await ProductInterest.find({product:productId}).select("weight").lean();
  if (!rows.length) return {rating:null, interestCount:0, score:null};
  // Нормалізований бал: середня сила + бонус за обсяг, плавно обмежений 1..5.
  const average = rows.reduce((sum,row)=>sum+Number(row.weight||0),0)/rows.length;
  const volume = Math.min(1, Math.log1p(rows.length)/Math.log(11));
  const rating = Math.max(1, Math.min(5, Math.round((1 + (average/100)*3 + volume)*10)/10));
  return {rating:Math.max(1,Math.min(5,Math.round(rating))),interestCount:rows.length,score:Math.round(rating*100)/100};
};

r.post("/:productId", canWrite, wrap(async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.productId)) throw new AppError(400,"Некоректний товар");
  const body = z.object({level:id,channel:id,comment:z.string().trim().max(1000).optional().default(""),idempotencyKey:z.string().trim().min(8).max(100).optional()}).parse(req.body);
  if (body.idempotencyKey) { const existing = await ProductInterest.findOne({product:req.params.productId,idempotencyKey:body.idempotencyKey}); if(existing){ const rating=await calcRating(req.params.productId); return res.status(200).json({item:{id:String(existing._id)},...rating}); } }
  const [product,level,channel] = await Promise.all([
    Product.findById(req.params.productId),
    InterestLevel.findOne({_id:body.level,active:true}),
    InterestChannel.findOne({_id:body.channel,active:true})
  ]);
  if (!product) throw new AppError(404,"Товар не знайдено");
  if (!level) throw new AppError(400,"Оберіть доступний рівень зацікавленості");
  if (!channel) throw new AppError(400,"Оберіть доступний канал");
  const doc = await ProductInterest.create({product:product._id,level:level._id,channel:channel._id,weight:level.weight,comment:body.comment,createdBy:req.user._id,recordedAt:new Date(),idempotencyKey:body.idempotencyKey});
  const rating = await calcRating(product._id);
  product.interestCount = rating.interestCount;
  await product.save();
  res.status(201).json({item:{id:String(doc._id),product:{id:String(product._id),name:product.name},level:out(level),channel:out(channel),comment:doc.comment,recordedAt:doc.recordedAt},...rating});
}));

r.patch("/:productId/:interestId", canWrite, wrap(async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.productId) || !mongoose.isValidObjectId(req.params.interestId)) throw new AppError(400,"Некоректний ідентифікатор");
  const body = z.object({
    level: id,
    channel: id,
    comment: z.string().trim().max(1000).optional().default(""),
    recordedAt: z.coerce.date()
  }).parse(req.body);
  const [doc, level, channel] = await Promise.all([
    ProductInterest.findOne({_id:req.params.interestId, product:req.params.productId}),
    InterestLevel.findOne({_id:body.level, active:true}),
    InterestChannel.findOne({_id:body.channel, active:true})
  ]);
  if (!doc) throw new AppError(404,"Зацікавленість не знайдено");
  if (!level) throw new AppError(400,"Оберіть доступний рівень зацікавленості");
  if (!channel) throw new AppError(400,"Оберіть доступний канал");
  doc.level = level._id;
  doc.channel = channel._id;
  doc.weight = level.weight;
  doc.comment = body.comment;
  doc.recordedAt = body.recordedAt;
  await doc.save();
  const rating = await calcRating(req.params.productId);
  await Product.updateOne({_id:req.params.productId}, { $set:{interestCount:rating.interestCount} });
  res.json({ok:true,...rating});
}));

r.get("/:productId", wrap(async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.productId)) throw new AppError(400,"Некоректний товар");
  const rows = await ProductInterest.find({product:req.params.productId}).sort({recordedAt:-1}).limit(500).populate("level","name weight").populate("channel","name").populate("createdBy","name").lean();
  const rating = await calcRating(req.params.productId);
  res.json({items:rows.map(x=>({id:String(x._id),levelId:x.level?._id?String(x.level._id):"",channelId:x.channel?._id?String(x.channel._id):"",level:x.level?.name||"Видалений рівень",weight:x.weight,channel:x.channel?.name||"Видалений канал",comment:x.comment||"",recordedAt:x.recordedAt,createdBy:x.createdBy?.name||null})),...rating});
}));

r.get("/analytics/summary", wrap(async (req,res) => {
  const {from,to,product,channel} = req.query;
  const filter={};
  if (from || to) {
    const range = {};
    if (from && !Number.isNaN(new Date(from).getTime())) range.$gte = new Date(from);
    if (to && !Number.isNaN(new Date(to).getTime())) { const end = new Date(to); end.setDate(end.getDate() + 1); range.$lt = end; }
    if (Object.keys(range).length) filter.recordedAt = range;
  }
  if (product && mongoose.isValidObjectId(product)) filter.product=new mongoose.Types.ObjectId(product);
  if (channel && mongoose.isValidObjectId(channel)) filter.channel=new mongoose.Types.ObjectId(channel);
  const rows=await ProductInterest.find(filter).populate("product","name sku").populate("level","name weight").populate("channel","name").lean();
  const map=new Map();
  const channels=new Map(), levels=new Map(), days=new Map(), months=new Map();
  for(const x of rows){
    const pid=String(x.product?._id||""); if(!pid) continue;
    const v=map.get(pid)||{product:{id:pid,name:x.product.name,sku:x.product.sku},count:0,totalWeight:0};
    v.count++;v.totalWeight+=Number(x.weight||0);map.set(pid,v);
    const cn=x.channel?.name||"Інший";channels.set(cn,(channels.get(cn)||0)+1);
    const ln=x.level?.name||"Інший";levels.set(ln,(levels.get(ln)||0)+1);
    const date=new Date(x.recordedAt);const day=date.toISOString().slice(0,10),month=day.slice(0,7);
    days.set(day,(days.get(day)||0)+1);months.set(month,(months.get(month)||0)+1);
  }
  const products=[...map.values()].map(x=>({...x,avgWeight:x.count?x.totalWeight/x.count:0,rating:Math.max(1,Math.min(5,Math.round((1+(x.totalWeight/x.count/100)*3+Math.min(1,Math.log1p(x.count)/Math.log(11)))*10)/10))})).sort((a,b)=>b.rating-a.rating||b.count-a.count);
  const pairs=m=>[...m].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
  const chronological=m=>[...m].map(([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name));
  res.json({total:rows.length,products:products.slice(0,100),channels:pairs(channels),levels:pairs(levels),byDay:chronological(days),byMonth:chronological(months)});
}));
export default r;
