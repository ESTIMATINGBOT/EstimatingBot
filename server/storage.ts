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

// Create tables if not exists
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
  );

  CREATE TABLE IF NOT EXISTS customer_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    session_id TEXT,
    name TEXT,
    company TEXT,
    phone TEXT,
    typical_bar_sizes TEXT,
    typical_products TEXT,
    last_quote_summary TEXT,
    quote_count INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS flagged_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    customer_name TEXT,
    flag_reason TEXT,
    flag_detail TEXT,
    customer_message TEXT,
    bot_response TEXT,
    full_conversation_json TEXT,
    status TEXT DEFAULT 'pending',
    reviewed_at TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS learned_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_text TEXT NOT NULL,
    source_flag_id INTEGER,
    category TEXT,
    added_by TEXT DEFAULT 'brian',
    active INTEGER DEFAULT 1,
    created_at TEXT
  );
`);

export interface IStorage {
  // Bids
  createBid(bid: InsertBid & { originalFilename: string; createdAt: string }): Bid;
  getBid(id: number): Bid | undefined;
  updateBidStatus(id: number, status: string, message?: string, pdfPath?: string): Bid | undefined;
  getAllBids(): Bid[];

  // Customer memory
  upsertCustomerMemory(email: string, data: {
    sessionId?: string;
    name?: string;
    company?: string;
    phone?: string;
    typicalBarSizes?: string;
    typicalProducts?: string;
    lastQuoteSummary?: string;
    quoteCount?: number;
    notes?: string;
  }): void;
  getCustomerMemoryByEmail(email: string): any | null;
  getCustomerMemoryBySession(sessionId: string): any | null;

  // Flagged conversations
  flagConversation(data: {
    sessionId: string;
    customerName?: string;
    flagReason: string;
    flagDetail: string;
    customerMessage: string;
    botResponse: string;
    fullConversationJson: string;
  }): void;
  getPendingFlags(): any[];
  reviewFlag(id: number, status: 'approved' | 'dismissed'): void;

  // Learned rules
  addLearnedRule(ruleText: string, category: string, sourceFlagId?: number): void;
  getLearnedRules(): { id: number; ruleText: string; category: string }[];
  deactivateLearnedRule(id: number): void;
}

class SqliteStorage implements IStorage {
  // ── BIDS ─────────────────────────────────────────────────────────────────

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

  // ── CUSTOMER MEMORY ──────────────────────────────────────────────────────

  upsertCustomerMemory(email: string, data: {
    sessionId?: string;
    name?: string;
    company?: string;
    phone?: string;
    typicalBarSizes?: string;
    typicalProducts?: string;
    lastQuoteSummary?: string;
    quoteCount?: number;
    notes?: string;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getCustomerMemoryByEmail(email);
    if (!existing) {
      db.prepare(`
        INSERT INTO customer_memory
          (email, session_id, name, company, phone, typical_bar_sizes, typical_products,
           last_quote_summary, quote_count, notes, created_at, updated_at)
        VALUES
          (@email, @sessionId, @name, @company, @phone, @typicalBarSizes, @typicalProducts,
           @lastQuoteSummary, @quoteCount, @notes, @createdAt, @updatedAt)
      `).run({
        email,
        sessionId: data.sessionId ?? null,
        name: data.name ?? null,
        company: data.company ?? null,
        phone: data.phone ?? null,
        typicalBarSizes: data.typicalBarSizes ?? null,
        typicalProducts: data.typicalProducts ?? null,
        lastQuoteSummary: data.lastQuoteSummary ?? null,
        quoteCount: data.quoteCount ?? 0,
        notes: data.notes ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      // Only update fields that are provided (non-undefined)
      const updates: string[] = ["updated_at = @updatedAt"];
      const params: Record<string, any> = { email, updatedAt: now };

      if (data.sessionId !== undefined) { updates.push("session_id = @sessionId"); params.sessionId = data.sessionId; }
      if (data.name !== undefined) { updates.push("name = @name"); params.name = data.name; }
      if (data.company !== undefined) { updates.push("company = @company"); params.company = data.company; }
      if (data.phone !== undefined) { updates.push("phone = @phone"); params.phone = data.phone; }
      if (data.typicalBarSizes !== undefined) { updates.push("typical_bar_sizes = @typicalBarSizes"); params.typicalBarSizes = data.typicalBarSizes; }
      if (data.typicalProducts !== undefined) { updates.push("typical_products = @typicalProducts"); params.typicalProducts = data.typicalProducts; }
      if (data.lastQuoteSummary !== undefined) { updates.push("last_quote_summary = @lastQuoteSummary"); params.lastQuoteSummary = data.lastQuoteSummary; }
      if (data.quoteCount !== undefined) { updates.push("quote_count = @quoteCount"); params.quoteCount = data.quoteCount; }
      if (data.notes !== undefined) { updates.push("notes = @notes"); params.notes = data.notes; }

      db.prepare(`UPDATE customer_memory SET ${updates.join(", ")} WHERE email = @email`).run(params);
    }
  }

  getCustomerMemoryByEmail(email: string): any | null {
    return db.prepare("SELECT * FROM customer_memory WHERE email = ?").get(email) ?? null;
  }

  getCustomerMemoryBySession(sessionId: string): any | null {
    return db.prepare("SELECT * FROM customer_memory WHERE session_id = ?").get(sessionId) ?? null;
  }

  // ── FLAGGED CONVERSATIONS ────────────────────────────────────────────────

  flagConversation(data: {
    sessionId: string;
    customerName?: string;
    flagReason: string;
    flagDetail: string;
    customerMessage: string;
    botResponse: string;
    fullConversationJson: string;
  }): void {
    db.prepare(`
      INSERT INTO flagged_conversations
        (session_id, customer_name, flag_reason, flag_detail, customer_message, bot_response,
         full_conversation_json, status, created_at)
      VALUES
        (@sessionId, @customerName, @flagReason, @flagDetail, @customerMessage, @botResponse,
         @fullConversationJson, 'pending', @createdAt)
    `).run({
      sessionId: data.sessionId,
      customerName: data.customerName ?? null,
      flagReason: data.flagReason,
      flagDetail: data.flagDetail,
      customerMessage: data.customerMessage,
      botResponse: data.botResponse,
      fullConversationJson: data.fullConversationJson,
      createdAt: new Date().toISOString(),
    });
  }

  getPendingFlags(): any[] {
    return db.prepare("SELECT * FROM flagged_conversations WHERE status = 'pending' ORDER BY id DESC").all();
  }

  reviewFlag(id: number, status: 'approved' | 'dismissed'): void {
    db.prepare(`
      UPDATE flagged_conversations SET status = ?, reviewed_at = ? WHERE id = ?
    `).run(status, new Date().toISOString(), id);
  }

  // ── LEARNED RULES ────────────────────────────────────────────────────────

  addLearnedRule(ruleText: string, category: string, sourceFlagId?: number): void {
    db.prepare(`
      INSERT INTO learned_rules (rule_text, source_flag_id, category, added_by, active, created_at)
      VALUES (@ruleText, @sourceFlagId, @category, 'brian', 1, @createdAt)
    `).run({
      ruleText,
      sourceFlagId: sourceFlagId ?? null,
      category,
      createdAt: new Date().toISOString(),
    });
  }

  getLearnedRules(): { id: number; ruleText: string; category: string }[] {
    return db
      .prepare("SELECT id, rule_text AS ruleText, category FROM learned_rules WHERE active = 1 ORDER BY id ASC")
      .all() as { id: number; ruleText: string; category: string }[];
  }

  deactivateLearnedRule(id: number): void {
    db.prepare("UPDATE learned_rules SET active = 0 WHERE id = ?").run(id);
  }
}

export const storage = new SqliteStorage();
