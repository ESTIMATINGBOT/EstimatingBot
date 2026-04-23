// Pure in-memory bid store — no native SQLite dependency.
// Bids only need to survive long enough for the customer to poll status
// (a few minutes). This avoids the better-sqlite3 native addon which
// causes segfaults on Railway due to architecture mismatches.

import { type Bid, type InsertBid } from "@shared/schema";

export interface IStorage {
  createBid(bid: InsertBid & { originalFilename: string; createdAt: string }): Bid;
  getBid(id: number): Bid | undefined;
  updateBidStatus(id: number, status: string, message?: string, pdfPath?: string): Bid | undefined;
  getAllBids(): Bid[];
}

class MemoryStorage implements IStorage {
  private bids: Map<number, Bid> = new Map();
  private nextId = 1;

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
    return bid;
  }

  getAllBids(): Bid[] {
    return Array.from(this.bids.values());
  }
}

export const storage = new MemoryStorage();
