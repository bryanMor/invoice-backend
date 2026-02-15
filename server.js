const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.get('/', (req, res) => {
    res.send("Invoice Backend Running");
});

app.post('/api/extract', async (req, res) => {
    try {

        const { base64Image } = req.body;

        if (!base64Image) {
            return res.status(400).json({ error: "No image provided" });
        }

        if (!GEMINI_API_KEY) {
            return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
        }

        const promptText = `
You are an invoice data extraction engine.

Extract ONLY structured JSON.

Return JSON in this exact format:

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

IMPORTANT RULES:
- netCost must be the CASE cost (not unit cost)
- unitsPerCase must be number of units inside one case
- qtyOrdered must be number of cases ordered
- If unsure, estimate logically from invoice
- Return ONLY JSON
`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
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

	console.log("Gemini raw response:", JSON.stringify(data));

        if (!data.candidates || !data.candidates[0]) {
            return res.status(500).json({ error: "Invalid Gemini response" });
        }

        const textOutput = data.candidates[0].content.parts[0].text;

        // Clean possible markdown formatting
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

        res.json(parsed);

    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: "Server crashed" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
