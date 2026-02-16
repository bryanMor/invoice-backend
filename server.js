const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/* ===============================
   MASTER CASE + QTY EXTRACTION
================================= */

function extractMasterCase(rawLine) {
    if (!rawLine) return null;
    const match = rawLine.match(/CS(\d{6})/);
    return match ? parseInt(match[1]) : null;
}

function extractQtyOrdered(rawLine) {
    if (!rawLine) return null;
    const match = rawLine.match(/\+(\d{4})/);
    return match ? parseInt(match[1]) : null;
}

/* ===============================
   SUB-CASE HIERARCHY LOGIC
================================= */

function calculateUnitsPerCase(description, rawLine) {
    if (!description) return 1;

    const desc = description.toUpperCase();

    // 1️⃣ Handle 2/15 PACK format
    const slashMatch = desc.match(/(\d+)\s*\/\s*(\d+)/);
    if (slashMatch) {
        return parseInt(slashMatch[1]);
    }

    const masterCaseSize = extractMasterCase(rawLine);

    // 2️⃣ Handle 6PK / 12PK / 24PK
    const pkMatch = desc.match(/(\d+)\s*PK/);

    if (pkMatch && masterCaseSize) {
        const packSize = parseInt(pkMatch[1]);

        if (packSize > 0 && masterCaseSize >= packSize) {
            const derived = masterCaseSize / packSize;

            if (Number.isInteger(derived) && derived > 1) {
                return derived;
            }
        }
    }

    // 3️⃣ Default (single-level case)
    return 1;
}

/* ===============================
   SAFETY VALIDATION
================================= */

function validateUnitsPerCase(units) {
    if (!units) return false;
    if (units <= 0) return false;
    if (units > 200) return false;
    return true;
}

app.get('/', (req, res) => {
    res.send("Invoice Backend Running");
});

app.post('/api/extract', async (req, res) => {
    try {

        const { base64Image } = req.body;

        if (!base64Image) {
            return res.status(400).json({ error: "No image provided" });
        }

        const promptText = `
Extract invoice data as strict JSON.

Return this exact format:

{
  "vendorName": "string",
  "invoiceDate": "YYYY-MM-DD",
  "items": [
    {
      "upc": "string",
      "description": "string",
      "sku": "string",
      "netCost": number,
      "rawLine": "entire raw invoice row as text"
    }
  ]
}

IMPORTANT:
- netCost is CASE cost.
- Include the FULL RAW LINE text exactly as seen.
- Do NOT calculate pack.
- Return ONLY JSON.
`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                { text: promptText },
                                {
                                    inline_data: {
                                        mime_type: "image/jpeg",
                                        data: base64Image.split(',')[1]
                                    }
                                }
                            ]
                        }
                    ]
                })
            }
        );

        const data = await response.json();

        if (!data.candidates || !data.candidates[0]) {
            return res.status(500).json({ error: "Invalid Gemini response" });
        }

        const textOutput = data.candidates[0].content.parts[0].text;

        const cleaned = textOutput
            .replace(/```json/g, '')
            .replace(/```/g, '')
            .trim();

        let parsed;

        try {
            parsed = JSON.parse(cleaned);
        } catch (err) {
            console.error("JSON parse failed:", cleaned);
            return res.status(500).json({ error: "Failed to parse Gemini JSON" });
        }

        /* ===============================
           FINAL PROCESSING LAYER
        ================================= */

        parsed.items = parsed.items.map(item => {

            const masterCaseSize = extractMasterCase(item.rawLine);
            const qtyFromRaw = extractQtyOrdered(item.rawLine);

            let finalUnits = calculateUnitsPerCase(
                item.description,
                item.rawLine
            );

            if (!validateUnitsPerCase(finalUnits)) {
                finalUnits = 1;
            }

            const qtyOrdered = qtyFromRaw || item.qtyOrdered || 1;

            // Margin sanity check
            const caseCost = parseFloat(item.netCost || 0);
            const unitCost = finalUnits > 0 ? caseCost / finalUnits : 0;
            const retailEstimate = unitCost * 1.35;
            const margin = retailEstimate > 0
                ? ((retailEstimate - unitCost) / retailEstimate) * 100
                : 0;

            return {
                ...item,
                masterCaseSize,
                unitsPerCase: finalUnits,
                qtyOrdered,
                marginWarning: (margin < 10 || margin > 80)
            };
        });

        res.json(parsed);

    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: "Server crashed" });
    }
});

app.listen(PORT, () => {
