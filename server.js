/**
 * server.js — Invoice OCR + Normalization + Vendor Rules + Total Validation + Safe Retry
 *
 * What this includes (everything we discussed):
 * - Node/Express backend with CORS + JSON (10mb) for base64 images
 * - Gemini Vision OCR (Google Generative Language API)
 * - Robust Gemini JSON parsing (strips ``` fences + safe JSON.parse)
 * - Stable output fields: vendorName, vendorKey, invoiceDate, invoiceTotal, grandTotal, totalMatches, warnings, items[]
 * - qtyOrdered preserves ZERO (never turns 0 into 1)
 * - unitsPerCase master/sub-case logic:
 *    - X/Y like "2/15" => X
 *    - 6PK + csValue==1 => 4 (beverage base rule)
 *    - 12PK + csValue==1 => 2
 *    - otherwise csValue (if present) else 1
 * - Uses lineAmount (if provided) to correct suspicious qty via math (amount ≈ qty * netCost)
 * - Computes grandTotal = SUM(netCost * qtyOrdered)
 * - Optional retry: if invoiceTotal is present and grandTotal mismatch -> re-run OCR with correction prompt
 *   (retry is safe: if retry fails, returns first-pass response with warnings, no 500)
 * - Vendor rules engine:
 *    - DEFAULT
 *    - BEVERAGE_BASE (used by similar 8–10 vendors)
 *    - Example override placeholder for BONBRIGHTDISTR (you can expand)
 *
 * Notes:
 * - Ensure GEMINI_API_KEY is set in Render env vars.
 * - Model is set to gemini-2.5-flash by default (change below if needed).
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();

const allowedOrigins = ["https://bryanmor.github.io"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY (set it in .env locally or Render env vars)");
}

// Use the model you confirmed works.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/* ===============================
   SAFE PARSING + NORMALIZATION HELPERS
================================= */

function parseGeminiJSON(geminiData) {
  const rawText =
    geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
    geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "";

  if (!rawText) throw new Error("Gemini returned empty text");

  const cleaned = String(rawText)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("❌ Failed to parse Gemini JSON");
    console.error("RAW:", rawText);
    console.error("CLEANED:", cleaned);
    throw err;
  }
}

function normalizeVendorKey(vendorName) {
  return String(vendorName || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function totalsMatch(computed, printed, tolerance = 0.05) {
  if (printed === null || printed === undefined || Number.isNaN(printed)) return false;
  return Math.abs(round2(computed) - round2(printed)) <= tolerance;
}

function safeMoney(v, fallback = 0) {
  if (v === null || v === undefined) return fallback;

  const s = String(v)
    .replace(/[Oo]/g, "0")
    .replace(/[lI]/g, "1")
    .replace(/[^0-9.\-]/g, "")
    .trim();

  if (s === "" || s === "." || s === "-" || s === "-.") return fallback;

  const n = parseFloat(s);
  return Number.isNaN(n) ? fallback : n;
}

// Preserves 0; does NOT turn 0 into 1.
// If missing/invalid -> fallback (default 0).
function safeIntPreserveZero(v, fallback = 0) {
  if (v === null || v === undefined) return fallback;

  const s = String(v)
    .replace(/[Oo]/g, "0")
    .replace(/[lI]/g, "1")
    .replace(/[^0-9\-]/g, "")
    .trim();

  if (s === "") return fallback;

  const n = parseInt(s, 10);
  return Number.isNaN(n) ? fallback : n;
}

function extractMasterCase(rawLine) {
  if (!rawLine) return null;
  const match = String(rawLine).match(/CS(\d{6})/);
  return match ? parseInt(match[1], 10) : null;
}

function parseBase64DataUrl(dataUrl) {
  const [prefix, base64] = String(dataUrl || "").split(",");
  const match = prefix.match(/^data:(.+);base64$/);
  return {
    mimeType: match ? match[1].trim() : "image/jpeg",
    base64: base64 || ""
  };
}

/**
 * Correct qty using lineAmount when OCR qty is suspicious.
 * - If amount is ~0 => qty = 0
 * - Else if netCost > 0 => qty = round(amount / netCost) when close enough
 */
function correctQtyUsingAmount({ qtyOrdered, netCost, lineAmount }) {
  const cost = safeMoney(netCost, NaN);
  const amt = safeMoney(lineAmount, NaN);

  // If amount is effectively zero, qty should be zero.
  if (!Number.isNaN(amt) && Math.abs(amt) < 0.005) return 0;

  // Infer qty from amount/cost when near an integer.
  if (!Number.isNaN(amt) && !Number.isNaN(cost) && cost > 0) {
    const inferred = Math.round(amt / cost);
    if (inferred >= 0 && inferred <= 9999) {
      const expectedAmt = inferred * cost;
      const tolerance = Math.max(0.05, expectedAmt * 0.01); // 5 cents or 1%
      if (Math.abs(expectedAmt - amt) <= tolerance) return inferred;
    }
  }

  return qtyOrdered;
}

function validateUnitsPerCase(units) {
  if (!units) return false;
  if (units <= 0) return false;
  if (units > 200) return false;
  return true;
}

/* ===============================
   VENDOR RULE ENGINE
================================= */

const vendorRules = {
  DEFAULT: {
    // Normalize UPC to digits; keep 11 chars for your B record logic.
    normalizeUPC: (item) => String(item.upc || "").replace(/\D/g, "").substring(0, 11),
    normalizeSKU: (item) => String(item.sku || "").replace(/\D/g, ""),
    // Preserve zero. Default invalid/missing to 0 (safe for totals).
    normalizeQty: (item) => safeIntPreserveZero(item.qtyOrdered, 0),
    normalizeNetCost: (item) => safeMoney(item.netCost, 0),
    normalizeLineAmount: (item) => safeMoney(item.lineAmount, NaN),
    // Default to provided unitsPerCase if present; else 1.
    normalizeUnitsPerCase: (item) => {
      const u = safeIntPreserveZero(item.unitsPerCase, 0);
      return validateUnitsPerCase(u) ? u : 1;
    }
  },

  // Base for your 8–10 similar beverage vendors
  BEVERAGE_BASE: {
    normalizeUPC: (item) => String(item.upc || "").replace(/\D/g, "").substring(0, 11),
    normalizeSKU: (item) => String(item.sku || "").replace(/\D/g, ""),
    normalizeQty: (item) => safeIntPreserveZero(item.qtyOrdered, 0),
    normalizeNetCost: (item) => safeMoney(item.netCost, 0),
    normalizeLineAmount: (item) => safeMoney(item.lineAmount, NaN),

    normalizeUnitsPerCase: (item) => {
      const desc = item.description ? String(item.description).toUpperCase() : "";
      const rawLine = item.rawLine ? String(item.rawLine) : "";

      // Read CS value if present (many vendors encode some case/subcase there)
      const csValue = extractMasterCase(rawLine) ?? 1;

      // 1) X/Y format (e.g. "2/15 PACK" => 2 sub-cases per master)
      const slashMatch = desc.match(/(\d+)\s*\/\s*(\d+)/);
      if (slashMatch) {
        const x = parseInt(slashMatch[1], 10);
        return validateUnitsPerCase(x) ? x : 1;
      }

      // 2) If vendor encodes sub-case count in CS and it's > 1, trust it
      if (csValue && csValue > 1) {
        return validateUnitsPerCase(csValue) ? csValue : 1;
      }

      // 3) Common beverage hierarchy heuristics when csValue==1:
      if (desc.includes("6PK") && csValue === 1) return 4;
      if (desc.includes("12PK") && csValue === 1) return 2;

      // 4) Otherwise default to 1
      return 1;
    }
  },

};

// Fix the BONBRIGHTDISTR inheritance cleanly (avoid spreading null above)
vendorRules.BONBRIGHTDISTR = {
  ...vendorRules.BEVERAGE_BASE,
  // You can override any single rule here later if needed.
};

/* ===============================
   GEMINI CALL
================================= */

async function callGeminiForInvoice({ base64, mimeType, promptText }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const geminiRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: promptText },
            {
              inlineData: {
                mimeType: mimeType || "image/jpeg",
                data: base64
              }
            }
          ]
        }
      ]
    })
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    throw new Error(`Gemini API request failed: ${errText}`);
  }

  const geminiData = await geminiRes.json();
  return parseGeminiJSON(geminiData);
}

/* ===============================
   NORMALIZE INTO STABLE OUTPUT
================================= */

function normalizeParsed(rawParsed) {
  const parsed = rawParsed && typeof rawParsed === "object" ? rawParsed : {};

  parsed.vendorName = parsed.vendorName || "";
  parsed.vendorKey = normalizeVendorKey(parsed.vendorName);
  parsed.invoiceDate = parsed.invoiceDate || null;

  // Printed invoice total (may be null if missing)
  parsed.invoiceTotal =
    parsed.invoiceTotal !== undefined && parsed.invoiceTotal !== null
      ? safeMoney(parsed.invoiceTotal, NaN)
      : null;

  // Items array safety
  parsed.items = Array.isArray(parsed.items) ? parsed.items : [];

  // Pick rules:
  // - if vendor specific exists -> use it
  // - else use BEVERAGE_BASE (optional default for your domain)
  // - else DEFAULT
  const rules =
    vendorRules[parsed.vendorKey] ||
    vendorRules.BEVERAGE_BASE ||
    vendorRules.DEFAULT;

  let computedGrandTotal = 0;

  parsed.items = parsed.items.map((item, idx) => {
    const it = item && typeof item === "object" ? item : {};

    const masterCaseSize = extractMasterCase(it.rawLine);

    const upc = rules.normalizeUPC(it);
    const sku = rules.normalizeSKU(it);

    // units per case (sub-cases per master, for your EDI logic)
    let unitsPerCase = rules.normalizeUnitsPerCase(it);
    if (!validateUnitsPerCase(unitsPerCase)) unitsPerCase = 1;

    // qty ordered (cases). Preserve 0. Default missing/invalid to 0.
    let qtyOrdered = rules.normalizeQty(it);

    const netCost = rules.normalizeNetCost(it); // net CASE cost
    const lineAmount = rules.normalizeLineAmount(it); // optional extended amount from invoice

    // Try to auto-correct qty when amount supports it
    const correctedQty = correctQtyUsingAmount({
      qtyOrdered,
      netCost,
      lineAmount
    });

    const qtyCorrected = correctedQty !== qtyOrdered;
    qtyOrdered = correctedQty;

    const lineTotal = netCost * qtyOrdered;
    computedGrandTotal += lineTotal;

    // Optional margin warning (kept from earlier work)
    const unitCost = unitsPerCase > 0 ? netCost / unitsPerCase : 0;
    const retailEstimate = unitCost * 1.35;
    const margin =
      retailEstimate > 0 ? ((retailEstimate - unitCost) / retailEstimate) * 100 : 0;

    const warnings = [];
    if (!upc || upc.length < 11) warnings.push("UPC_MISSING_OR_SHORT");
    if (qtyOrdered === 0) warnings.push("QTY_ZERO");
    if (qtyCorrected) warnings.push("QTY_CORRECTED_FROM_AMOUNT");
    if (netCost <= 0) warnings.push("NETCOST_MISSING_OR_ZERO");
    if (Number.isNaN(lineAmount)) {
      // we store null below; no warning needed unless you want:
      // warnings.push("LINEAMOUNT_MISSING");
    }

    return {
      // Keep your current field names to avoid breaking frontend
      upc: it.upc,
      upc11: upc,
      description: it.description || "",
      sku: it.sku,
      skuDigits: sku,
      netCost: round2(netCost),
      lineAmount: Number.isNaN(lineAmount) ? null : round2(lineAmount),
      rawLine: it.rawLine || "",
      masterCaseSize,
      unitsPerCase,
      qtyOrdered,
      lineTotal: round2(lineTotal),
      marginWarning: margin < 10 || margin > 80,
      warnings
    };
  });

  parsed.grandTotal = round2(computedGrandTotal);

  return parsed;
}

/* ===============================
   PROMPTS
================================= */

function buildInitialPrompt() {
  // Stable schema request (raw + structured). Keep it strict.
  return (
    "Extract invoice data as strict JSON.\n\n" +
    "Return this exact format:\n\n" +
    "{\n" +
    '  "vendorName": "string",\n' +
    '  "invoiceDate": "YYYY-MM-DD",\n' +
    '  "invoiceTotal": number,\n' +
    '  "items": [\n' +
    "    {\n" +
    '      "upc": "string",\n' +
    '      "description": "string",\n' +
    '      "sku": "string",\n' +
    '      "qtyOrdered": number,\n' +
    '      "netCost": number,\n' +
    '      "lineAmount": number,\n' +
    '      "rawLine": "full raw invoice line"\n' +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    "IMPORTANT:\n" +
    "- invoiceTotal MUST be the final printed grand total on the invoice (after discounts).\n" +
    "- netCost is the NET CASE cost after discounts for that line.\n" +
    "- lineAmount is the extended AMOUNT column for that item row (if present).\n" +
    "- Include FULL raw invoice line for each item (exactly as shown).\n" +
    "- Quantity must be extracted exactly as printed in the quantity column.\n" +
    "- If quantity shows 0, return 0.\n" +
    "- Do NOT guess quantity.\n" +
    "- Do NOT default quantity to 1.\n" +
    "- Return ONLY JSON. Do not wrap in markdown.\n"
  );
}

function buildCorrectionPrompt({ printedTotal, computedTotal }) {
  // Keep correction prompt short to reduce failure risk.
  return (
    "Your extracted totals do not match the invoice.\n\n" +
    `Printed invoiceTotal: ${printedTotal}\n` +
    `Computed (sum of netCost * qtyOrdered): ${computedTotal}\n\n` +
    "TASK:\n" +
    "- Re-check the invoice image carefully.\n" +
    "- Fix qtyOrdered, netCost, and/or lineAmount ONLY where incorrect.\n" +
    "- qtyOrdered must match the printed quantity column exactly (0 must stay 0).\n" +
    "- Return corrected JSON in the SAME FORMAT as before.\n" +
    "- Return ONLY JSON. No markdown.\n"
  );
}

/* ===============================
   ROUTES
================================= */

app.get("/", (req, res) => {
  res.send("Invoice Backend Running");
});

app.post("/api/extract", async (req, res) => {
  try {
    const base64Image = req.body.base64Image;

    if (!base64Image) {
      return res.status(400).json({ error: "No image provided" });
    }

    const { mimeType, base64 } = parseBase64DataUrl(base64Image);
    if (!base64) {
      return res.status(400).json({ error: "Invalid image or PDF data" });
    }

    // Pass A: initial extraction
    const initialPrompt = buildInitialPrompt();
    const rawA = await callGeminiForInvoice({ base64, mimeType, promptText: initialPrompt });
    let parsedA = normalizeParsed(rawA);
    if (!Array.isArray(parsedA.items)) parsedA.items = [];

    // Compute match vs printed total
    const printedTotalA =
      parsedA.invoiceTotal === null ? NaN : safeMoney(parsedA.invoiceTotal, NaN);
    const computedTotalA = parsedA.grandTotal;

    const matchA =
      !Number.isNaN(printedTotalA) && totalsMatch(computedTotalA, printedTotalA, 0.05);

    parsedA.totalMatches = matchA;
    parsedA.warnings = parsedA.warnings || [];

    if (Number.isNaN(printedTotalA)) {
      parsedA.warnings.push("INVOICE_TOTAL_MISSING");
      // If printed total missing, we cannot enforce match—return first pass.
      return res.json(parsedA);
    }

    // If already matches, return
    if (matchA) {
      return res.json(parsedA);
    }

    // If mismatch, try Pass B correction (SAFE: if it fails, return A with warnings)
    try {
      const correctionPrompt = buildCorrectionPrompt({
        printedTotal: printedTotalA,
        computedTotal: computedTotalA
      });

      const rawB = await callGeminiForInvoice({
        base64,
        mimeType,
        promptText: correctionPrompt
      });

      const parsedB = normalizeParsed(rawB);
      if (!Array.isArray(parsedB.items)) parsedB.items = [];

      const printedTotalB =
        parsedB.invoiceTotal === null ? NaN : safeMoney(parsedB.invoiceTotal, NaN);
      const computedTotalB = parsedB.grandTotal;

      const matchB =
        !Number.isNaN(printedTotalB) && totalsMatch(computedTotalB, printedTotalB, 0.05);

      parsedB.totalMatches = matchB;
      parsedB.warnings = parsedB.warnings || [];

      if (!matchB) {
        parsedB.warnings.push("TOTAL_MISMATCH_NEEDS_REVIEW");
      }

      return res.json(parsedB);
    } catch (retryErr) {
      console.error("Retry failed, returning first-pass result:", retryErr);
      parsedA.warnings.push("TOTAL_MISMATCH_NEEDS_REVIEW");
      parsedA.warnings.push("RETRY_FAILED");
      return res.json(parsedA);
    }
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Server crashed" });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});