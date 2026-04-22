import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const bids = sqliteTable("bids", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone").notNull(),
  projectName: text("project_name"),
  originalFilename: text("original_filename").notNull(),
  status: text("status").notNull().default("pending"), // pending | processing | complete | failed
  statusMessage: text("status_message"),
  pdfPath: text("pdf_path"),
  createdAt: text("created_at").notNull(),
});

export const insertBidSchema = createInsertSchema(bids).omit({
  id: true,
  status: true,
  statusMessage: true,
  pdfPath: true,
  createdAt: true,
});

export type InsertBid = z.infer<typeof insertBidSchema>;
export type Bid = typeof bids.$inferSelect;
