import { AuditLog } from "../models/index.js";

export const audit = (session, { entityType, entityId, action, changes, user }) =>
  AuditLog.create([{ entityType, entityId, action, changes, user: user?._id }], { session });
