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
          `Estimate generated but email delivery failed. Please contact us directly.${grandTotalStr ? ` Grand total: ${grandTotalStr}` : ""}`,
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
