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

    if (!rawLine) return 1;

    const desc = description ? description.toUpperCase() : "";

    const csMatch = rawLine.match(/CS(\d{6})/);
    const csValue = csMatch ? parseInt(csMatch[1]) : 1;

    // 1️⃣ X/Y format
    const slashMatch = desc.match(/(\d+)\s*\/\s*(\d+)/);
    if (slashMatch) {
        return parseInt(slashMatch[1]);
    }

    // 2️⃣ 6PK hierarchy rule
    if (desc.includes("6PK") && csValue === 1) {
        return 4;
    }

    // 3️⃣ 12PK hierarchy rule (rare but possible)
    if (desc.includes("12PK") && csValue === 1) {
        return 2;
    }

    // 4️⃣ Otherwise use CS value directly
    return csValue || 1;
}


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
            '    {\n' +
            '      "upc": "string",\n' +
            '      "description": "string",\n' +
            '      "sku": "string",\n' +
            '      "netCost": number,\n' +
            '      "rawLine": "full raw invoice line"\n' +
            '    }\n' +
            '  ]\n' +
            "}\n\n" +
            "IMPORTANT:\n" +
            "- netCost is CASE cost.\n" +
            "- Include FULL raw invoice row.\n" +
            "- Do NOT calculate unitsPerCase.\n" +
            "- Return ONLY JSON.";

        const response = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY,
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

        parsed.items = parsed.items.map(function (item) {

            const masterCaseSize = extractMasterCase(item.rawLine);
            const qtyFromRaw = extractQtyOrdered(item.rawLine);

            let finalUnits = calculateUnitsPerCase(
                item.description,
                item.rawLine
            );

            if (!validateUnitsPerCase(finalUnits)) {
                finalUnits = 1;
            }

            const qtyOrdered = qtyFromRaw || 1;

            const caseCost = parseFloat(item.netCost || 0);
            const unitCost = finalUnits > 0 ? caseCost / finalUnits : 0;
            const retailEstimate = unitCost * 1.35;
            const margin = retailEstimate > 0
                ? ((retailEstimate - unitCost) / retailEstimate) * 100
                : 0;

            return {
                upc: item.upc,
                description: item.description,
                sku: item.sku,
                netCost: item.netCost,
                rawLine: item.rawLine,
                masterCaseSize: masterCaseSize,
                unitsPerCase: finalUnits,
                qtyOrdered: qtyOrdered,
                marginWarning: (margin < 10 || margin > 80)
            };
        });

        res.json(parsed);

    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: "Server crashed" });
    }
});

app.listen(PORT, function () {
    console.log("Server running on port " + PORT);
});