// File-backed bid store.
// STORE_PATH is configurable via BID_STORE_PATH env var.
// On Railway: mount a persistent volume at /data and set BID_STORE_PATH=/data/rcp_bids.json
// Falls back to /tmp (wiped on redeploy) if env var not set.

import fs from "fs";
import path from "path";
import { type Bid, type InsertBid } from "@shared/schema";

const STORE_PATH = process.env.BID_STORE_PATH || "/tmp/rcp_bids.json";

// Ensure the directory exists
try {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
} catch {}

console.log(`[storage] Bid store path: ${STORE_PATH}`);

export interface IStorage {
  createBid(bid: InsertBid & { originalFilename: string; createdAt: string }): Bid;
  getBid(id: number): Bid | undefined;
  updateBidStatus(id: number, status: string, message?: string, pdfPath?: string): Bid | undefined;
  getAllBids(): Bid[];
}

class FileStorage implements IStorage {
  private bids: Map<number, Bid> = new Map();
  private nextId = 1;

  constructor() {
    this._load();
  }

  private _load() {
    try {
      if (fs.existsSync(STORE_PATH)) {
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
        this.bids = new Map(raw.bids.map((b: Bid) => [b.id, b]));
        this.nextId = raw.nextId ?? (Math.max(0, ...raw.bids.map((b: Bid) => b.id)) + 1);
      }
    } catch {
      // corrupt or missing — start fresh
      this.bids = new Map();
      this.nextId = 1;
    }
  }

  private _save() {
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify({
        nextId: this.nextId,
        bids: Array.from(this.bids.values()),
      }), "utf8");
    } catch {
      // /tmp not writable in some environments — continue without persistence
    }
  }

  createBid(data: InsertBid & { originalFilename: string; createdAt: string }): Bid {
    const bid: Bid = {
      id: this.nextId++,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerPhone: data.customerPhone,
      projectName: data.projectName ?? null,
      originalFilename: data.originalFilename,
      status: "pending",
      statusMessage: null,
      pdfPath: null,
      createdAt: data.createdAt,
    };
    this.bids.set(bid.id, bid);
    this._save();
    return bid;
  }

  getBid(id: number): Bid | undefined {
    return this.bids.get(id);
  }

  updateBidStatus(id: number, status: string, message?: string, pdfPath?: string): Bid | undefined {
    const bid = this.bids.get(id);
    if (!bid) return undefined;
    bid.status = status;
    bid.statusMessage = message ?? null;
    bid.pdfPath = pdfPath ?? null;
    this._save();
    return bid;
  }

  getAllBids(): Bid[] {
    return Array.from(this.bids.values());
  }
}

export const storage = new FileStorage();
