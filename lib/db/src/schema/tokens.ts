import { pgTable, text, serial, numeric, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tokensTable = pgTable("tokens", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  price: numeric("price", { precision: 30, scale: 10 }).notNull().default("0"),
  change24h: numeric("change24h", { precision: 10, scale: 4 }).notNull().default("0"),
  volume24h: numeric("volume24h", { precision: 30, scale: 4 }).notNull().default("0"),
  logoUrl: text("logo_url").notNull(),
  contractAddress: text("contract_address"),
  isNative: boolean("is_native").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTokenSchema = createInsertSchema(tokensTable).omit({ id: true, createdAt: true });
export type InsertToken = z.infer<typeof insertTokenSchema>;
export type Token = typeof tokensTable.$inferSelect;
