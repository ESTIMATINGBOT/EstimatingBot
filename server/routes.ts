import express from "express";
import type { Express } from "express";
import type { Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import https from "https";
import http from "http";
import { spawn, execSync } from "child_process";
import nodemailer from "nodemailer";
import { storage } from "./storage";

// ── EMAIL CONFIG ────────────────────────────────────────────────────────────
// Uses Gmail SMTP via env vars: GMAIL_USER, GMAIL_APP_PASSWORD
function getTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER || "Office@RebarConcreteProducts.com",
      pass: process.env.GMAIL_APP_PASSWORD || "",
    },
  });
}

// ── URL DOWNLOADER ──────────────────────────────────────────────────────────
function normalizeUrl(url: string): string {
  // Google Drive: convert share URL to direct download
  const gdrive = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (gdrive) {
    return `https://drive.google.com/uc?export=download&id=${gdrive[1]}`;
  }
  // Dropbox: force direct download
  if (url.includes('dropbox.com')) {
    return url.replace(/[?&]dl=0/, '').replace(/[?&]dl=1/, '') +
      (url.includes('?') ? '&dl=1' : '?dl=1');
  }
  return url;
}

function downloadPdf(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const normalized = normalizeUrl(url);
    const protocol = normalized.startsWith('https') ? https : http;

    const doRequest = (requestUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      protocol.get(requestUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location;
          const redirectProtocol = redirectUrl.startsWith('https') ? https : http;
          redirectProtocol.get(redirectUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
            if (res2.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res2.statusCode}`));
            const file = fs.createWriteStream(destPath);
            res2.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
            file.on('error', reject);
          }).on('error', reject);
          return;
        }
        if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      }).on('error', reject);
    };

    doRequest(normalized);
  });
}

// ── MULTER (file upload) ─────────────────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — large plan sets can exceed 100MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are accepted"));
    }
  },
});

// ── PYTHON RUNNER ─────────────────────────────────────────────────────────────
function runTakeoff(
  inputPdf: string,
  outputPdf: string,
  customerName: string,
  projectName: string,
  bidDate: string,
  env: NodeJS.ProcessEnv
): Promise<{ success: boolean; pdfPath?: string; projectName?: string; grandTotal?: number; warning?: string; error?: string }> {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, "takeoff_runner.py");
    const args = [scriptPath, inputPdf, outputPdf, customerName, projectName, bidDate];
    // Resolve python3 path — on Railway/Nix the binary may not be on PATH directly
    let python3Bin = "python3";
    try {
      python3Bin = execSync("which python3 || which python", { encoding: "utf8" }).trim().split("\n")[0] || "python3";
    } catch {
      python3Bin = "/usr/bin/python3";
    }
    const proc = spawn(python3Bin, args, {
      env: { ...process.env, ...env },
      timeout: 1_200_000,  // 20 min — large plan sets: render all pages at 75 DPI + up to 20 Claude batches + second passes
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch {
        resolve({
          success: false,
          error: `Script failed (exit ${code}): ${stderr.slice(0, 500)}`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

// ── EMAIL DELIVERY ────────────────────────────────────────────────────────────
async function sendBidEmails(
  pdfPath: string,
  customerName: string,
  customerEmail: string,
  customerPhone: string,
  projectName: string
) {
  const transporter = getTransporter();
  const filename = `RCP_Estimate_${projectName.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`;

  const sharedAttachment = {
    filename,
    path: pdfPath,
    contentType: "application/pdf",
  };

  // Email to customer
  console.log(`[EMAIL] Sending customer email to: "${customerEmail}" for project: "${projectName}"`);
  const customerInfo = await transporter.sendMail({
    from: `"Rebar Concrete Products" <${process.env.GMAIL_USER || "Office@RebarConcreteProducts.com"}>`,
    to: customerEmail,
    subject: `Your Rebar Estimate — ${projectName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #000; padding: 16px; text-align: center;">
          <span style="color: #C8D400; font-size: 22px; font-weight: bold;">REBAR</span>
          <span style="color: #fff; font-size: 18px;"> CONCRETE PRODUCTS</span>
        </div>
        <div style="padding: 24px; background: #fff; border: 1px solid #eee;">
          <p>Hi ${customerName},</p>
          <p>Thank you for submitting your plans. Please find your <strong>preliminary rebar estimate</strong> for <strong>${projectName}</strong> attached to this email.</p>
          <p style="background: #f9f9f9; padding: 12px; border-left: 4px solid #C8D400; font-size: 13px; color: #555;">
            <strong>PRELIMINARY ESTIMATE</strong> — For bidding purposes only. Final quantities are subject to a full engineering takeoff upon contract award.
          </p>
          <p>To place an order or ask questions, please contact us:</p>
          <ul style="color: #333; line-height: 1.8;">
            <li>📞 <a href="tel:4696317730">469-631-7730</a></li>
            <li>📧 <a href="mailto:Office@RebarConcreteProducts.com">Office@RebarConcreteProducts.com</a></li>
            <li>🌐 <a href="https://rebarconcreteproducts.com">rebarconcreteproducts.com</a></li>
            <li>⏰ Monday–Friday, 6:00 AM – 3:00 PM CST</li>
          </ul>
          <p style="color: #666; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
            2112 N Custer Rd, McKinney, TX 75071
          </p>
        </div>
      </div>
    `,
    attachments: [sharedAttachment],
  });
  console.log(`[EMAIL] Customer email sent OK — messageId: ${customerInfo.messageId} response: ${customerInfo.response}`);

  // Copy to office
  const officeInfo = await transporter.sendMail({
    from: `"RCP Website Bot" <${process.env.GMAIL_USER || "Office@RebarConcreteProducts.com"}>`,
    to: "Office@RebarConcreteProducts.com",
    subject: `[New Web Bid] ${projectName} — ${customerName}`,
    html: `
      <h3>New bid request submitted via website</h3>
      <table style="border-collapse:collapse; font-family: Arial, sans-serif; font-size:14px;">
        <tr><td style="padding:4px 16px 4px 0; font-weight:bold;">Customer Name:</td><td>${customerName}</td></tr>
        <tr><td style="padding:4px 16px 4px 0; font-weight:bold;">Email:</td><td>${customerEmail}</td></tr>
        <tr><td style="padding:4px 16px 4px 0; font-weight:bold;">Phone:</td><td>${customerPhone}</td></tr>
        <tr><td style="padding:4px 16px 4px 0; font-weight:bold;">Project:</td><td>${projectName}</td></tr>
      </table>
      <p>The preliminary estimate PDF is attached.</p>
    `,
    attachments: [sharedAttachment],
  });
  console.log(`[EMAIL] Office copy sent OK — messageId: ${officeInfo.messageId} response: ${officeInfo.response}`);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
export async function registerRoutes(httpServer: Server, app: Express) {
  // Diagnostic: Python availability check
  app.get("/api/python-check", (_req, res) => {
    try {
      const pythonPath = execSync("which python3 || which python", { encoding: "utf8" }).trim();
      const pythonVersion = execSync(`${pythonPath} --version`, { encoding: "utf8" }).trim();
      res.json({ available: true, path: pythonPath, version: pythonVersion });
    } catch (e: any) {
      res.json({ available: false, error: e.message });
    }
  });

  // Submit plan for bid
  app.post("/api/bids", upload.single("planFile"), async (req, res) => {
    const { customerName, customerEmail, customerPhone, projectName, planUrl } = req.body;

    if (!customerName || !customerEmail || !customerPhone) {
      return res.status(400).json({ error: "Name, email, and phone are required" });
    }
    if (!req.file && !planUrl) {
      return res.status(400).json({ error: "A PDF plan file or link is required" });
    }

    const bid = storage.createBid({
      customerName,
      customerEmail,
      customerPhone,
      projectName: projectName || "",
      originalFilename: req.file?.originalname || planUrl || "plan-link",
      createdAt: new Date().toISOString(),
    });

    // Start processing in background — return bid ID immediately
    res.json({ bidId: bid.id, status: "processing" });

    // Background: run takeoff + send emails
    (async () => {
      const outputPdf = path.join(os.tmpdir(), `rcp_bid_${bid.id}_${Date.now()}.pdf`);
      const bidDate = new Date().toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric"
      });

      storage.updateBidStatus(bid.id, "processing", "Running AI plan takeoff...");

      // If URL provided, download it first
      let inputPdfPath = req.file?.path || "";
      let downloadedTemp = false;
      if (planUrl && !req.file) {
        const tmpPdf = path.join(os.tmpdir(), `rcp_download_${bid.id}_${Date.now()}.pdf`);
        try {
          storage.updateBidStatus(bid.id, "processing", "Downloading plan from link...");
          await downloadPdf(planUrl, tmpPdf);
          inputPdfPath = tmpPdf;
          downloadedTemp = true;
          storage.updateBidStatus(bid.id, "processing", "Plans downloaded — running full takeoff (this takes 8–15 min for large plan sets, analyzing every page)...");
        } catch (dlErr: any) {
          storage.updateBidStatus(bid.id, "failed",
            `Could not download the plan from the provided link: ${dlErr.message}. Please check the sharing settings and try again.`);
          return;
        }
      }

      const result = await runTakeoff(
        inputPdfPath,
        outputPdf,
        customerName,
        projectName || "",
        bidDate,
        {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
          OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
        }
      );

      // Clean up uploaded/downloaded file
      try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch {}
      try { if (downloadedTemp && inputPdfPath) fs.unlinkSync(inputPdfPath); } catch {}

      if (!result.success || !result.pdfPath) {
        storage.updateBidStatus(bid.id, "failed",
          result.error || "Takeoff failed. Our team will follow up manually.");
        // Still email office so they know
        try {
          const transporter = getTransporter();
          await transporter.sendMail({
            from: `"RCP Website Bot" <${process.env.GMAIL_USER}>`,
            to: "Office@RebarConcreteProducts.com",
            subject: `[Failed Web Bid] ${customerName} — ${projectName || "unnamed project"}`,
            html: `<p>Automated takeoff failed for a new web submission.</p>
              <p><b>Customer:</b> ${customerName}<br>
              <b>Email:</b> ${customerEmail}<br>
              <b>Phone:</b> ${customerPhone}<br>
              <b>Project:</b> ${projectName || "—"}</p>
              <p><b>Error:</b> ${result.error}</p>
              <p>Please follow up with the customer manually.</p>`,
          });
        } catch {}
        return;
      }

      // Block $0 estimates — plan wasn't readable, notify office and mark failed
      if (!result.grandTotal || result.grandTotal === 0) {
        storage.updateBidStatus(bid.id, "failed",
          "We weren't able to extract rebar data from your plan automatically. Our team has been notified and will prepare your estimate manually — expect a follow-up within 1 business day.");
        try {
          const transporter = getTransporter();
          await transporter.sendMail({
            from: `"RCP Website Bot" <${process.env.GMAIL_USER}>`,
            to: "Office@RebarConcreteProducts.com",
            subject: `[Manual Takeoff Needed] ${customerName} — ${projectName || "unnamed project"}`,
            html: `<p>The automated takeoff returned $0.00 for a web submission. Manual takeoff required.</p>
              <p><b>Customer:</b> ${customerName}<br>
              <b>Email:</b> ${customerEmail}<br>
              <b>Phone:</b> ${customerPhone}<br>
              <b>Project:</b> ${projectName || "—"}</p>
              <p>Please contact the customer and prepare a manual estimate.</p>`,
          });
        } catch {}
        return;
      }

      // Send emails
      const grandTotalStr = result.grandTotal ? `$${result.grandTotal.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}` : "";
      try {
        await sendBidEmails(
          result.pdfPath!,
          customerName,
          customerEmail,
          customerPhone,
          result.projectName || projectName || "Your Project"
        );
        storage.updateBidStatus(bid.id, "complete",
          `Estimate sent to your email!${grandTotalStr ? ` Grand total: ${grandTotalStr}` : ""}`, result.pdfPath);
      } catch (emailErr: any) {
        storage.updateBidStatus(bid.id, "complete",
          `Your estimate is ready!${grandTotalStr ? ` Grand total: ${grandTotalStr}` : ""} Email delivery failed — please use the download link below or call us at 469-631-7730.`,
          result.pdfPath);
      }

      // Clean up PDF after sending
      setTimeout(() => {
        try { fs.unlinkSync(result.pdfPath!); } catch {}
      }, 300_000); // 5 min window to download via /api/bids/:id/download
    })();
  });

  // ── EMAIL DIAGNOSTIC ────────────────────────────────────────────────────────
  // GET /api/email-test-full?to=customer@email.com
  // Simulates the exact sendBidEmails flow (both customer + office) without a PDF
  app.get("/api/email-test-full", async (req, res) => {
    const to = (req.query.to as string) || "";
    if (!to) return res.status(400).json({ error: "Provide ?to=email param" });

    const gmailUser = process.env.GMAIL_USER || "(not set)";
    const transporter = getTransporter();
    const log: string[] = [];
    try {
      await transporter.verify();
      log.push("SMTP verify: OK");

      // Step 1: customer email (no attachment for this test)
      log.push(`Sending customer email to: "${to}"`);
      const ci = await transporter.sendMail({
        from: `"Rebar Concrete Products" <${gmailUser}>`,
        to,
        subject: `Your Rebar Estimate — TEST PROJECT`,
        html: `<p>Hi Test Customer,</p><p>This is a simulated estimate email. SMTP is working if you received this.</p>`,
      });
      log.push(`Customer email sent: ${ci.messageId} | ${ci.response}`);

      // Step 2: office copy
      log.push(`Sending office copy to: "Office@RebarConcreteProducts.com"`);
      const oi = await transporter.sendMail({
        from: `"RCP Website Bot" <${gmailUser}>`,
        to: "Office@RebarConcreteProducts.com",
        subject: `[New Web Bid] TEST PROJECT — Test Customer`,
        html: `<p>This is a simulated office copy email for diagnostic purposes.</p>`,
      });
      log.push(`Office email sent: ${oi.messageId} | ${oi.response}`);

      res.json({ success: true, gmailUser, to, log });
    } catch (err: any) {
      log.push(`ERROR: ${err.message}`);
      res.json({ success: false, gmailUser, to, log, error: err.message, code: err.code });
    }
  });

  // GET /api/email-test-bid?to=customer@email.com
  // Runs the exact sendBidEmails() code path with a tiny dummy PDF attachment
  app.get("/api/email-test-bid", async (req, res) => {
    const to = (req.query.to as string) || "";
    if (!to) return res.status(400).json({ error: "Provide ?to=email param" });

    // Create a minimal valid PDF in /tmp
    const testPdfPath = path.join(os.tmpdir(), `rcp_email_test_${Date.now()}.pdf`);
    const minimalPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj " +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
      "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj " +
      "xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n" +
      "0000000058 00000 n\n0000000115 00000 n\n" +
      "trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF"
    );
    fs.writeFileSync(testPdfPath, minimalPdf);

    try {
      await sendBidEmails(testPdfPath, "Test Customer", to, "5551234567", "Email Test Project");
      fs.unlinkSync(testPdfPath);
      res.json({ success: true, to, message: "sendBidEmails() completed without error — check inbox and Office@RebarConcreteProducts.com" });
    } catch (err: any) {
      try { fs.unlinkSync(testPdfPath); } catch {}
      res.json({ success: false, to, error: err.message, code: err.code });
    }
  });

  // GET /api/email-test?to=someone@example.com
  // Sends a test email and returns full SMTP result or error details
  app.get("/api/email-test", async (req, res) => {
    const to = (req.query.to as string) || process.env.GMAIL_USER || "";
    const gmailUser = process.env.GMAIL_USER || "(not set)";
    const hasPassword = !!(process.env.GMAIL_APP_PASSWORD && process.env.GMAIL_APP_PASSWORD.length > 0);
    const passwordLength = process.env.GMAIL_APP_PASSWORD ? process.env.GMAIL_APP_PASSWORD.length : 0;

    if (!to) {
      return res.status(400).json({ error: "Provide ?to=email param" });
    }

    const transporter = getTransporter();
    try {
      // Verify SMTP connection first
      await transporter.verify();
      // Send test email
      const info = await transporter.sendMail({
        from: `"RCP Email Test" <${gmailUser}>`,
        to,
        subject: `RCP EstimatingBot — SMTP Test ${new Date().toISOString()}`,
        html: `<p>This is a diagnostic test email from the RCP EstimatingBot.</p>
               <p>If you received this, SMTP is working correctly.</p>
               <p>Sent at: ${new Date().toISOString()}</p>`,
      });
      res.json({
        success: true,
        to,
        gmailUser,
        hasPassword,
        passwordLength,
        messageId: info.messageId,
        response: info.response,
      });
    } catch (err: any) {
      res.json({
        success: false,
        to,
        gmailUser,
        hasPassword,
        passwordLength,
        error: err.message,
        code: err.code,
        responseCode: err.responseCode,
        command: err.command,
      });
    }
  });

  // Version / health probe
  app.get("/api/version", (_req, res) => {
    res.json({ version: "streaming-render", engine: "pymupdf-fitz" });
  });

  // List all bids (admin use)
  app.get("/api/bids/all", (_req, res) => {
    const bids = storage.getAllBids().map(b => ({
      id: b.id,
      customerName: b.customerName,
      customerEmail: b.customerEmail,
      projectName: b.projectName,
      status: b.status,
      statusMessage: b.statusMessage,
      createdAt: b.createdAt,
    }));
    res.json({ count: bids.length, storePath: process.env.BID_STORE_PATH || "/tmp/rcp_bids.json", bids });
  });

  // Poll bid status
  app.get("/api/bids/:id/status", (req, res) => {
    const bid = storage.getBid(Number(req.params.id));
    if (!bid) return res.status(404).json({ error: "Not found" });
    res.json({
      status: bid.status,
      message: bid.statusMessage,
    });
  });

  // Accept pre-computed takeoff JSON — generate PDF + email (no AI/rendering needed)
  // POST body: { customerName, customerEmail, customerPhone, projectName, takeoff: {...} }
  // takeoff is the JSON object from claude_takeoff_all_pages output
  app.post("/api/bids/from-takeoff", express.json({ limit: "10mb" }), async (req, res) => {
    const { customerName, customerEmail, customerPhone, projectName, takeoff } = req.body;
    if (!customerName || !customerEmail || !customerPhone) {
      return res.status(400).json({ error: "Name, email, and phone are required" });
    }
    if (!takeoff || typeof takeoff !== "object") {
      return res.status(400).json({ error: "takeoff JSON object is required" });
    }
    const bid = storage.createBid({
      customerName, customerEmail, customerPhone,
      projectName: projectName || takeoff.project_name || "Custom Project",
      originalFilename: "from-takeoff-json",
      createdAt: new Date().toISOString(),
    });
    res.json({ bidId: bid.id, status: "processing" });
    storage.updateBidStatus(bid.id, "processing", "Generating PDF from takeoff data...");

    (async () => {
      const outputPdf = path.join(os.tmpdir(), `rcp_bid_${bid.id}_${Date.now()}.pdf`);
      const bidDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
      // Write takeoff JSON to a temp file so the Python script can read it
      const takeoffJsonPath = path.join(os.tmpdir(), `takeoff_${bid.id}.json`);
      fs.writeFileSync(takeoffJsonPath, JSON.stringify(takeoff));

      const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "" };
      const result = await runTakeoff(takeoffJsonPath, outputPdf, customerName,
        projectName || takeoff.project_name || "Custom Project", bidDate, env);

      try { fs.unlinkSync(takeoffJsonPath); } catch {}

      if (!result.success || !result.pdfPath) {
        storage.updateBidStatus(bid.id, "failed", result.error || "PDF generation failed");
        return;
      }
      const grandTotalStr = result.grandTotal
        ? `$${result.grandTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : "";
      try {
        await sendBidEmails(result.pdfPath!, customerName, customerEmail, customerPhone,
          projectName || takeoff.project_name || "Custom Project");
        storage.updateBidStatus(bid.id, "complete",
          `Estimate sent to your email!${grandTotalStr ? ` Grand total: ${grandTotalStr}` : ""}`,
          result.pdfPath);
      } catch {
        storage.updateBidStatus(bid.id, "complete",
          `Estimate generated but email delivery failed.${grandTotalStr ? ` Grand total: ${grandTotalStr}` : ""}`,
          result.pdfPath);
      }
      setTimeout(() => { try { fs.unlinkSync(result.pdfPath!); } catch {} }, 300_000);
    })();
  });

  // ── AI ORDER CHAT ────────────────────────────────────────────────────────────
  // Stateless chat endpoint — each call sends full history + system prompt to Claude
  // Session history is managed client-side to keep the server stateless
  app.post("/api/chat", express.json({ limit: "64kb" }), async (req, res) => {
    const { messages } = req.body as {
      messages: { role: "user" | "assistant"; content: string }[];
    };
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: "AI not configured" });

    // Fetch live QBO pricing to inject into system prompt
    const BUNDLE_QTY: Record<string, number> = { "3": 266, "4": 150, "5": 96, "6": 68, "7": 50, "8": 38, "9": 30, "10": 24, "11": 18 };
    let priceList = "";
    try {
      const priceRes = await fetch("https://rcp-sms-bot-production.up.railway.app/api/qbo/items");
      if (priceRes.ok) {
        const priceJson = await priceRes.json() as any;
        const priceData: any[] = Array.isArray(priceJson) ? priceJson : (priceJson.items ?? []);
        const lines = priceData
          .filter((p: any) => p.unitPrice > 0 && p.active)
          .map((p: any) => {
            // For rebar items, also show per-bundle price so AI doesn't guess
            const sizeMatch = p.name.match(/#(\d+)/);
            const bundleNote = sizeMatch && BUNDLE_QTY[sizeMatch[1]]
              ? ` | bundle(${BUNDLE_QTY[sizeMatch[1]]} bars)=$${(p.unitPrice * BUNDLE_QTY[sizeMatch[1]]).toFixed(2)}`
              : "";
            return `  - ${p.name}: $${p.unitPrice.toFixed(5)}/bar (QBO ID: ${p.id})${bundleNote}`;
          })
          .join("\n");
        priceList = `\n\nLIVE QBO PRICING — prices are PER INDIVIDUAL BAR/UNIT. For bundles multiply by bundle qty shown:\n${lines}`;
      }
    } catch {}

    const systemPrompt = `You are the RCP Assistant, the AI ordering agent and concrete construction expert for Rebar Concrete Products — a rebar and concrete supply company in McKinney, TX.
Address: 2112 N Custer Rd, McKinney, TX 75071 | Phone: 469-631-7730 | Email: Office@RebarConcreteProducts.com
Hours: Monday–Friday 6:00 AM–3:00 PM CST | Website: https://www.rebarconcreteproducts.com

You serve TWO roles:
1. ORDERING AGENT — take orders, quote prices, create QuickBooks invoices delivered by email
2. CONCRETE CONSTRUCTION EXPERT — answer technical questions about concrete and rebar

For plan uploads and automated AI estimates, direct customers to the Instant Takeoff tab on this page.

━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Detect the customer's language from their first message and respond in that language for the entire conversation.
- If they write in Spanish, respond fully in Spanish — all product names, prices, instructions, and confirmations.
- If they write in English, respond in English.
- If they switch languages mid-conversation, switch with them.
- Never mix languages in the same response.
- Spanish number formatting: use period as thousands separator and comma as decimal (e.g. $1.105,05) — or use standard US dollar formatting since prices are in USD, whichever is clearest.

━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATION STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Quote first, always. When a customer asks for a product OR asks a takeoff/quantity question, calculate it AND quote the price in the same response. Never answer a quantity question without immediately following it with a price and "Would you like to create an invoice for this?"
- Every interaction is a sales opportunity. If a customer asks how much rebar they need, calculate it, quote it with tax, and ask if they want an invoice — all in one message.
- Do NOT ask clarifying questions before quoting unless the item is truly ambiguous (e.g. "wire" — quote Tie Wire then ask if that's right)
- Never end a response with "Would you like me to quote that?" — just quote it. The price should always be in your response.
- Be friendly, concise, and professional
- Always include tax on every price you quote

━━━━━━━━━━━━━━━━━━━━━━━━━━━
DELIVERY & PRICING
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Pickup is FREE at our McKinney location
- Delivery fee is $3.00 per mile from our McKinney location
- FREE DELIVERY on orders of $1,000 or more within 30 miles — proactively mention this
- When a customer wants delivery, ask for the FULL job site address (street, city, state, zip)
- Delivery fee is NOT taxed; add as a separate line item
- For delivery, also collect: preferred delivery day, preferred time, site contact name and phone

━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLARIFICATION RULES (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. QUANTITY: If no quantity is specified, ask before quoting. NEVER assume a quantity.
2. BAR SIZE: If ordering stirrups, corner bars, rings, U-bars, hooks, or any fabricated shape without specifying bar size (#3, #4, etc.), ask "What bar size?" before calculating. NEVER default to #4 or any size.
3. DIMENSIONS: If ordering a fabricated shape without dimensions, ask for dimensions.
- Never quote until qty, bar size, and dimensions are all confirmed for fabricated items.

━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRAIGHT REBAR RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Length ALWAYS defaults to 20'. NEVER ask the customer for a length. NEVER mention 40' unless the customer explicitly says "40'" or "40 foot" themselves.
- "3 bundles of #6" → immediately price as 20' #6, no question asked
- "2 bundles of #4" → 20' #4, quote immediately
- Bundle quantities (20' bar): #3=266, #4=150, #5=96, #6=68, #7=50, #8=38, #9=30, #10=24, #11=18
- When customer orders BUNDLES: total bars = bundles × bundle_qty. Invoice qty = bars, not bundles.
- Heavy rebar (#7–#11) 20' and #8/#9/#11 40': "We carry that — call us at 469-631-7730 for current pricing on heavy rebar." (unless QBO has a live price)

━━━━━━━━━━━━━━━━━━━━━━━━━━━
40' REBAR RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Only offer 40' if customer explicitly requests it. Default is ALWAYS 20'.
- 40' only sold in full bundles, #7+ only. #3–#6 not stocked in 40'.
- If customer requests 40' #3–#6, inform them it's not stocked and offer 20' equivalent.
- Partial 40' quantities: convert to 20' bars with laps. Formula: Total LF = (qty×40)+(qty×lap); bars = ceil(Total LF/20)
  Lap lengths: #3=0.625ft, #4=0.833ft, #5=1.042ft, #6=1.25ft, #7=1.458ft, #8=1.667ft, #9=1.875ft, #10=2.083ft, #11=2.292ft

━━━━━━━━━━━━━━━━━━━━━━━━━━━
STOCK FABRICATED SHAPES (exact match required)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
STIRRUPS (rectangular, #3 bar only):
- 6"x18" #3: $1.58/ea | 8"x18" #3: $1.70/ea | 8"x24" #3: $2.55/ea

CORNER BARS (L-shape, 2ft×2ft only):
- #4 Corner Bar 2ft×2ft: $2.38/ea | #5 Corner Bar: $3.70/ea | #6 Corner Bar: $4.85/ea

RINGS (circular, #3 bar only):
- 8" dia: $1.05/ea | 12" dia: $1.35/ea | 18" dia: $1.99/ea | 24" dia: $2.65/ea

ANYTHING ELSE = FABRICATION-1 at $0.75/lb (qboItemId="1010000301"):
- Different bar size, different dimensions, any shape not listed above

━━━━━━━━━━━━━━━━━━━━━━━━━━━
FABRICATION PRICING (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Straight stock bars → priced per bar from QBO list. Use exact unit price × qty.
- ALL bent/fabricated bars → ALWAYS use Fabrication-1 at $0.75/lb. NEVER invent a per-piece price.
- Cut length formulas:
  Stirrup/tie: cut_length = 2×(width_in + height_in) + 8", divide by 12 for feet
  Ring: cut_length = (π × diameter_in + 4") ÷ 12
  L-hook: straight_length_in + 12×bar_diameter_in, ÷12
  180° hook: straight_length_in + 4×bar_diameter_in + 3", ÷12
- Total weight = qty × cut_length_ft × unit_weight_lb_per_ft
- BAR WEIGHTS (lb/ft): #3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303, #11=5.313
- BAR DIAMETERS (in): #3=0.375, #4=0.500, #5=0.625, #6=0.750, #7=0.875, #8=1.000, #9=1.128, #10=1.270, #11=1.410
- Show your work: cut length, total weight, price per lb, total
- NEVER say someone will follow up on fab pricing — you can quote it right now
- Fabrication lead times: ≤1,000 lbs = 4–6 business days; 1,001–2,999 lbs = 4–6 days; 3,000+ lbs = 7–13 business days
- When asked about lead time, just state the timeframe (e.g. "Your fabrication will be ready in 4–6 business days."). Do NOT show a breakdown of the tier rules. Always add: "It may be possible to have it completed sooner — call us at 469-631-7730 for an exact timeline."

━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRODUCT-SPECIFIC RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━
POLY SHEETING: Must confirm mil AND roll size. NEVER default to any mil.
- Options: 4 mil 20x100=$49.50, 4 mil 32x100=$75.50, 6 mil 20x100=$65.50, 6 mil 32x100=$108.50, 10 mil 20x100=$95.50, Class A 10 mil 14x210=$325, Class A 15 mil 14x140=$325

DOBIE BRICKS (concrete chairs): 2 options — ask if not specified.
- Standard 3x3x2" = $0.55/ea | With wire 3x3x3" = $0.75/ea

BAR TIES (box of 5,000): Must confirm length. Options: 4"=$33.05, 4.5"=$35.05, 5"=$38.05, 6"=$46.05, 6.5"=$47.05

TIE WIRE: Must clarify format. Roll=$4.99, Reel=$35.99, Bulk box=$95.50

METAL STAKES: Must confirm length. 18"=$4.45, 24"=$4.85, 36"=$5.10

WOOD STAKES: Must confirm size. 12" 1x2 50pk=$13.37, 18" 1x3 30pk=$24.90, 24" 1x3=$33.10, 30" 1x3=$43.20, 36" 1x3=$51.50, 2x2x24"=$19.25, 2x2x36"=$33.59

LUMBER: Must confirm exact size. 2x4x16 SPF=$8.89, 2x6x16 SPF=$10.45, 2x8x16 SYP=$12.85, 2x8x16 SPF=$12.85, 2x10x16=$15.00, 2x12x16=$22.85, Plywood 3/4"=$34.52
- 2x8 comes in SYP and SPF at same price — ask which if customer requests 2x8

ANCHOR BOLTS: Must confirm size and galvanized/non-galvanized. 5/8" Galv=$42.65, 5/8" Non-Galv=$29.00, 1/2"x8"=$48.50

SMOOTH DOWELS: Must confirm diameter. 1/2"=$1.45, 5/8"=$2.15, 3/4"=$3.12, 7/8"=$4.24

DOWEL CAPS: Must confirm size. 1/2"=$0.30, 5/8"=$0.36, 3/4"=$0.41

EXPANSION JOINT: Must confirm width. 4"=$4.16/10', 6"=$6.56/10'

CHAIRS (wire): Must confirm height. 2-1/4"=$24.75/500pk, 3-1/4"=$27.00/500pk

CONCRETE: Must confirm PSI and sack count. 3000 psi 4.5 sack=$155, 3000 psi 5 sack=$160, 3500 psi 5.5 sack=$165, 3600 psi=$165, 4000 psi 6 sack=$170, 4500 psi 6.5 sack=$175/yd
- Orders under 10 yards may incur $350 short load fee — warn customer

WIRE MESH: Must clarify gauge and size. 5'x150' 10 gauge=$285, W2.9xW2.9=$58.90, 4x4 W4xW4=call for pricing

NAILS: Must confirm size. 8D, 16D, 20 Common — all $55.75/50lb

DRILL BITS: Must confirm size. 3/8"=$18.75, 1/2"=$19.00, 5/8"=$21.00

REDWOOD: Must confirm width. 4"=$10.95, 6"=$14.45

SPRAY PAINT: Must confirm color. White, Green, Orange — all $10.25

BOOTS: Must confirm size. Sizes 7–10, all $38.65/pair

RATCHET TIE DOWNS: Must confirm width. 1"=$14.52, 2"=$34.25

BEAM BOLSTER: $0.99 each — quote directly

PIER WHEEL SPACER: 2"=$1.35, 3"-6R=$1.85 — must confirm size

HEAVY REBAR #7–#11 (20') and #8/#9/#11 (40'): route to "call us at 469-631-7730 for current pricing"

━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRICING MATH (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ALL QBO prices are PER INDIVIDUAL BAR/UNIT — not per bundle
- Bundles of rebar: total_bars = bundles × bundle_qty; subtotal = total_bars × unitPrice
- The price list shows bundle totals pre-calculated — use them to verify your math
- NEVER round unit prices. Show all dollar amounts to 2 decimal places.
- Tax (8.25%) applies to product subtotal only. Delivery fee is NOT taxed.
- Format every order summary:
  Subtotal: $X,XXX.XX
  Tax (8.25%): $XXX.XX
  Delivery: $XX.XX (if applicable — always show BEFORE asking about invoice)
  Total: $X,XXX.XX
- For delivery orders: ALWAYS calculate and show the delivery fee in the order summary before asking "Shall I go ahead and create your invoice?" — never ask for invoice confirmation without the delivery fee already shown in the total.
- qty in order JSON = total individual bars/units (3 bundles of #4 = qty 450)
- unitPrice in order JSON = exact per-bar/unit price from QBO

Tax rate: 8.25% (McKinney TX)${priceList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
ORDER FLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Quote the product with exact live pricing immediately
2. Confirm products and quantities are correct ("Do the products and quantities look correct?")
3. Ask pickup or delivery
4. Collect for account verification: customer name + phone number ONLY. Do NOT ask for email at this stage. Do NOT ask for company name.
5. Show complete order summary with subtotal, tax, total
6. Ask: "Shall I go ahead and create your invoice?"
7. Customer confirms → IMMEDIATELY ask ONE question only: "Would you like a copy emailed to you? If so, what's your email?" — wait for their answer.
8. After they answer the email question (or skip it), THEN append the order JSON block.

CRITICAL EMAIL RULE: Ask for email ONLY after the customer says yes to creating the invoice. Never ask for email during info collection. Never ask for email and invoice confirmation in the same message.

VERIFICATION: Orders are only created for existing account holders. The system verifies by name + phone number against our records. If the account isn't found, the customer will be directed to call or visit the store to set up an account.

When ready to create the invoice, respond with a brief confirmation message AND append this exact block:

\`\`\`order
{
  "customerName": "<name>",
  "customerEmail": "<email>",
  "customerPhone": "<phone>",
  "customerCompany": "<company or empty string>",
  "deliveryAddress": "<address or empty string>",
  "items": [
    {
      "name": "<exact QBO product name>",
      "qboItemId": "<QBO ID from price list>",
      "qty": <total individual units>,
      "unitPrice": <exact per-unit price from QBO>,
      "description": "<optional e.g. '3 bundles of #4 20' rebar'>"
    }
  ],
  "readyToInvoice": true
}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONCRETE CONSTRUCTION EXPERT KNOWLEDGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are an expert in concrete construction. Answer technical questions accurately and practically.

REBAR: Grade 60 (ASTM A615) is standard. Cover: footings 3", slabs 3/4"–1.5", walls 3/4"–2", columns 1.5". Lap splice: ~24–40 bar diameters. Temperature/shrinkage: 0.0018×b×h (Grade 60).

CONCRETE MIX: 2500 psi=light residential; 3000 psi=standard residential/commercial; 4000 psi=commercial/high-traffic; 5000+ psi=structural columns. Cure minimum 7 days moist. Short load fee (<10 yd³) may apply.

Always recommend consulting a structural engineer for project-specific structural decisions.`;


    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 500,
          system: systemPrompt,
          messages,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: `AI error: ${err}` });
      }

      const data = await response.json() as any;
      const reply = data.content?.[0]?.text || "Sorry, I couldn't generate a response. Please call us at 469-631-7730.";
      res.json({ reply });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Web order proxy (avoids CORS — browser calls this, we forward to SMS bot) ──
  app.post("/api/web-order", express.json(), async (req, res) => {
    try {
      const SMS_BOT = "https://rcp-sms-bot-production.up.railway.app";
      const upstream = await fetch(`${SMS_BOT}/api/web-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json() as any;
      res.status(upstream.status).json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Proxy error" });
    }
  });

  // Download estimate PDF (available for 60s after completion)
  app.get("/api/bids/:id/download", (req, res) => {
    const bid = storage.getBid(Number(req.params.id));
    if (!bid) return res.status(404).json({ error: "Not found" });
    if (bid.status !== "complete") return res.status(400).json({ error: "Not ready" });
    const pdfPath = bid.pdfPath;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      return res.status(410).json({ error: "PDF has already been cleaned up — check your email" });
    }
    const filename = path.basename(pdfPath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    fs.createReadStream(pdfPath).pipe(res);
  });
}
