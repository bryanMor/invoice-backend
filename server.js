const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/* ===============================
   HELPERS
================================= */

function extractMasterCase(rawLine) {
  if (!rawLine) return null;
  const match = String(rawLine).match(/CS(\d{6})/);
  return match ? parseInt(match[1], 10) : null;
}

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


/**
 * Corrects qty using lineAmount when OCR qty is suspicious.
 * - If amount is ~0 => qty = 0
 * - Else if netCost > 0 => qty = round(amount / netCost) when close enough
 */
function correctQtyUsingAmount({ qtyOrdered, netCost, lineAmount }) {
  const cost = safeMoney(netCost, NaN);
  const amt = safeMoney(lineAmount, NaN);

  if (!Number.isNaN(amt) && Math.abs(amt) < 0.005) return 0;

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

/* ===============================
   SUB-CASE HIERARCHY LOGIC
================================= */

function calculateUnitsPerCase(description, rawLine) {
  if (!rawLine) return 1;

  const desc = description ? String(description).toUpperCase() : '';
  const csMatch = String(rawLine).match(/CS(\d{6})/);
  const csValue = csMatch ? parseInt(csMatch[1], 10) : 1;

  // 1) X/Y format (e.g., 1/15PK => 1)
  const slashMatch = desc.match(/(\d+)\s*\/\s*(\d+)/);
  if (slashMatch) return parseInt(slashMatch[1], 10);

  // 2) 6PK hierarchy rule
  if (desc.includes('6PK') && csValue === 1) return 4;

  // 3) 12PK hierarchy rule
  if (desc.includes('12PK') && csValue === 1) return 2;

  // 4) Otherwise use CS value directly
  return csValue || 1;
}

function validateUnitsPerCase(units) {
  if (!units) return false;
  if (units <= 0) return false;
  if (units > 200) return false;
  return true;
}

/* ===============================
   ROUTES
================================= */

app.get('/', (req, res) => {
  res.send("Invoice Backend Running");
});

app.post('/api/extract', async (req, res) => {
  try {
    const base64Image = req.body.base64Image;

    if (!base64Image) {
      return res.status(400).json({ error: "No image provided" });
    }

    const promptText =
      "Extract invoice data as strict JSON.\n\n" +
      "Return this exact format:\n\n" +
      "{\n" +
      '  "vendorName": "string",\n' +
      '  "invoiceDate": "YYYY-MM-DD",\n' +
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
      "- netCost is CASE cost.\n" +
      "- lineAmount is the extended AMOUNT column for that item row.\n" +
      "- Include FULL raw invoice line for each item.\n" +
      "- Quantity must be extracted exactly as printed.\n" +
      "- If quantity shows 0, return 0.\n" +
      "- Do NOT guess quantity.\n" +
      "- Do NOT default quantity to 1.\n" +
      "- Do not wrap in markdown.\n";

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: promptText },
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: base64Image.split(",")[1]
                  }
                }
              ]
            }
          ]
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", errText);
      return res.status(500).json({ error: "Gemini API request failed" });
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const cleaned = rawText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("JSON parse failed:", cleaned);
      return res.status(500).json({ error: "Failed to parse Gemini JSON" });
    }

    if (!parsed.items || !Array.isArray(parsed.items)) {
      return res.status(500).json({ error: "Invalid response format (items missing)" });
    }

    let grandTotal = 0;

    parsed.items = parsed.items.map(function (item) {
      const masterCaseSize = extractMasterCase(item.rawLine);

      let finalUnits = calculateUnitsPerCase(item.description, item.rawLine);
      if (!validateUnitsPerCase(finalUnits)) finalUnits = 1;

      // qty: preserve 0; default missing/invalid to 1 (you can change fallback to 0 if desired)
      let qtyOrdered = safeIntPreserveZero(item.qtyOrdered, 0);

      const caseCost = safeMoney(item.netCost, 0);
      const lineAmount = safeMoney(item.lineAmount, NaN);

      // auto-correct qty using amount math when possible
      qtyOrdered = correctQtyUsingAmount({
        qtyOrdered,
        netCost: caseCost,
        lineAmount
      });

      const lineTotal = caseCost * qtyOrdered;
      grandTotal += lineTotal;

      const unitCost = finalUnits > 0 ? caseCost / finalUnits : 0;
      const retailEstimate = unitCost * 1.35;
      const margin = retailEstimate > 0
        ? ((retailEstimate - unitCost) / retailEstimate) * 100
        : 0;

      return {
        upc: item.upc,
        description: item.description,
        sku: item.sku,
        netCost: caseCost,
        lineAmount: Number.isNaN(lineAmount) ? null : lineAmount,
        rawLine: item.rawLine,
        masterCaseSize,
        unitsPerCase: finalUnits,
        qtyOrdered,
        lineTotal: parseFloat(lineTotal.toFixed(2)),
        marginWarning: (margin < 10 || margin > 80)
      };
    });

    parsed.grandTotal = parseFloat(grandTotal.toFixed(2));
    res.json(parsed);

  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: "Server crashed" });
  }
});

app.listen(PORT, function () {
  console.log("Server running on port " + PORT);
});
