import { z } from "zod";

// Plain TypeScript types — no database dependency.
// The app uses an in-memory store (server/storage.ts).

export const insertBidSchema = z.object({
  customerName: z.string(),
  customerEmail: z.string(),
  customerPhone: z.string(),
  projectName: z.string().optional(),
  originalFilename: z.string().optional(),
});

export type InsertBid = z.infer<typeof insertBidSchema>;

export interface Bid {
  id: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  projectName: string | null;
  originalFilename: string;
  status: string;
  statusMessage: string | null;
  pdfPath: string | null;
  createdAt: string;
}
