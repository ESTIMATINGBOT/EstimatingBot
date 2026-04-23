import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { bids, type Bid, type InsertBid } from "@shared/schema";
import path from "path";
import fs from "fs";

// Use /tmp in production (Railway filesystem is ephemeral but writable at /tmp)
// Fall back to cwd for local dev
const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/tmp/bids.db'
  : path.join(process.cwd(), "bids.db");
const sqlite = new Database(DB_PATH);
const db = drizzle(sqlite);

// Ensure table exists
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    project_name TEXT,
    original_filename TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    status_message TEXT,
    pdf_path TEXT,
    created_at TEXT NOT NULL
  )
`);

export interface IStorage {
  createBid(bid: InsertBid & { originalFilename: string; createdAt: string }): Bid;
  getBid(id: number): Bid | undefined;
  updateBidStatus(id: number, status: string, message?: string, pdfPath?: string): Bid | undefined;
  getAllBids(): Bid[];
}

export class Storage implements IStorage {
  createBid(data: InsertBid & { originalFilename: string; createdAt: string }): Bid {
    return db.insert(bids).values(data).returning().get();
  }

  getBid(id: number): Bid | undefined {
    return db.select().from(bids).where(eq(bids.id, id)).get();
  }

  updateBidStatus(id: number, status: string, message?: string, pdfPath?: string): Bid | undefined {
    return db.update(bids)
      .set({
        status,
        statusMessage: message || null,
        pdfPath: pdfPath || null,
      })
      .where(eq(bids.id, id))
      .returning()
      .get();
  }

  getAllBids(): Bid[] {
    return db.select().from(bids).all();
  }
}

export const storage = new Storage();
