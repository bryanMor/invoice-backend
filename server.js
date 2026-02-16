const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Extract units safely from description
function extractUnitsFromDescription(description) {
    if (!description) return null;

    const desc = description.toLowerCase();

    const slashMatch = desc.match(/^(\d+)\s*\/\s*\d+/);
    if (slashMatch) return parseInt(slashMatch[1]);

    const xMatch = desc.match(/^(\d+)\s*x\s*\d+/);
    if (xMatch) return parseInt(xMatch[1]);

    const packMatch = desc.match(/(\d+)\s*(ct|pk|pack)/);
    if (packMatch) return parseInt(packMatch[1]);

    return null;
}

function validateUnitsPerCase(units) {
    if (!units) return false;
    if (units <= 0) return false;
    if (units > 500) return false;
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
      "unitsPerCase": number,
      "qtyOrdered": number
    }
  ]
}

IMPORTANT:
- netCost is CASE cost.
- unitsPerCase must be explicit from invoice.
- Do NOT multiply numbers from description.
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

        // SAFER PACK LOGIC
        parsed.items = parsed.items.map(item => {

            let finalUnits = null;

            if (item.unitsPerCase && item.unitsPerCase > 0) {
                finalUnits = parseInt(item.unitsPerCase);
            }

            if (!finalUnits) {
                const extracted = extractUnitsFromDescription(item.description);
                if (extracted) {
                    finalUnits = extracted;
                }
            }

            if (!finalUnits) {
                finalUnits = 1;
            }

            if (!validateUnitsPerCase(finalUnits)) {
                finalUnits = 1;
            }

            item.unitsPerCase = finalUnits;

            const caseCost = parseFloat(item.netCost || 0);
            const unitCost = caseCost / finalUnits;
            const retailEstimate = unitCost * 1.35;
            const margin = ((retailEstimate - unitCost) / retailEstimate) * 100;

            item.marginWarning = (margin < 10 || margin > 80);

            return item;
        });

        res.json(parsed);

    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: "Server crashed" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
