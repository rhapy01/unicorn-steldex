import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const transactionsTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(), // swap, add_liquidity, remove_liquidity
  walletAddress: text("wallet_address").notNull(),
  tokenASymbol: text("token_a_symbol").notNull(),
  tokenBSymbol: text("token_b_symbol").notNull(),
  amountA: numeric("amount_a", { precision: 30, scale: 10 }).notNull(),
  amountB: numeric("amount_b", { precision: 30, scale: 10 }).notNull(),
  txHash: text("tx_hash").notNull(),
  status: text("status").notNull().default("confirmed"), // pending, confirmed, failed
  valueUsd: numeric("value_usd", { precision: 20, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({ id: true, createdAt: true });
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
