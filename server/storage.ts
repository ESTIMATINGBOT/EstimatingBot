// SQLite-backed bid store.
// DB file path is configurable via BID_STORE_PATH env var.
// Defaults to /tmp/rcp_bids.db — set BID_STORE_PATH=/data/rcp_bids.db if using a Railway volume.
// SQLite is single-file and survives container restarts as long as the path persists.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { type Bid, type InsertBid } from "@shared/schema";

const DB_PATH = process.env.BID_STORE_PATH || "/tmp/rcp_bids.db";

try {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
} catch {}

console.log(`[storage] SQLite DB path: ${DB_PATH}`);

const db = new Database(DB_PATH);

// Create table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customerName TEXT NOT NULL,
    customerEmail TEXT NOT NULL,
    customerPhone TEXT NOT NULL,
    projectName TEXT,
    originalFilename TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    statusMessage TEXT,
    pdfPath TEXT,
    createdAt TEXT NOT NULL
  )
`);

export interface IStorage {
  createBid(bid: InsertBid & { originalFilename: string; createdAt: string }): Bid;
  getBid(id: number): Bid | undefined;
  updateBidStatus(id: number, status: string, message?: string, pdfPath?: string): Bid | undefined;
  getAllBids(): Bid[];
}

class SqliteStorage implements IStorage {
  createBid(data: InsertBid & { originalFilename: string; createdAt: string }): Bid {
    const stmt = db.prepare(`
      INSERT INTO bids (customerName, customerEmail, customerPhone, projectName, originalFilename, status, statusMessage, pdfPath, createdAt)
      VALUES (@customerName, @customerEmail, @customerPhone, @projectName, @originalFilename, 'pending', NULL, NULL, @createdAt)
    `);
    const result = stmt.run({
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerPhone: data.customerPhone,
      projectName: data.projectName ?? null,
      originalFilename: data.originalFilename,
      createdAt: data.createdAt,
    });
    return this.getBid(result.lastInsertRowid as number)!;
  }

  getBid(id: number): Bid | undefined {
    return db.prepare("SELECT * FROM bids WHERE id = ?").get(id) as Bid | undefined;
  }

  updateBidStatus(id: number, status: string, message?: string, pdfPath?: string): Bid | undefined {
    db.prepare(`
      UPDATE bids SET status = ?, statusMessage = ?, pdfPath = ? WHERE id = ?
    `).run(status, message ?? null, pdfPath ?? null, id);
    return this.getBid(id);
  }

  getAllBids(): Bid[] {
    return db.prepare("SELECT * FROM bids ORDER BY id DESC").all() as Bid[];
  }
}

export const storage = new SqliteStorage();
