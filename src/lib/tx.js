import mongoose from "mongoose";

/** Виконує fn(session) в одній транзакції MongoDB (потрібен replica set). */
export async function withTx(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
