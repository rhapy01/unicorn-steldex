import { pgTable, serial, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tokensTable } from "./tokens";

export const poolsTable = pgTable("pools", {
  id: serial("id").primaryKey(),
  tokenAId: integer("token_a_id").notNull().references(() => tokensTable.id),
  tokenBId: integer("token_b_id").notNull().references(() => tokensTable.id),
  reserveA: numeric("reserve_a", { precision: 30, scale: 10 }).notNull().default("0"),
  reserveB: numeric("reserve_b", { precision: 30, scale: 10 }).notNull().default("0"),
  totalLiquidity: numeric("total_liquidity", { precision: 30, scale: 4 }).notNull().default("0"),
  volume24h: numeric("volume24h", { precision: 30, scale: 4 }).notNull().default("0"),
  fees24h: numeric("fees24h", { precision: 30, scale: 4 }).notNull().default("0"),
  apy: numeric("apy", { precision: 10, scale: 4 }).notNull().default("0"),
  fee: numeric("fee", { precision: 6, scale: 4 }).notNull().default("0.003"),
  lpTokenSupply: numeric("lp_token_supply", { precision: 30, scale: 10 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPoolSchema = createInsertSchema(poolsTable).omit({ id: true, createdAt: true });
export type InsertPool = z.infer<typeof insertPoolSchema>;
export type Pool = typeof poolsTable.$inferSelect;
