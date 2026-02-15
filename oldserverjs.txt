require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/api/extract', async (req, res) => {
    try {
        const { base64Image } = req.body;

        if (!base64Image) {
            return res.status(400).json({ error: 'No image provided' });
        }

        const prompt = `Strict Grid-Lock Extraction:
        Extract Vendor Name, Invoice Date,
        and items with: upc, description, sku, netCost, unitsPerCase, qtyOrdered.
        Return ONLY JSON.`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            {
                                inline_data: {
                                    mime_type: "image/jpeg",
                                    data: base64Image.split(',')[1]
                                }
                            }
                        ]
                    }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        temperature: 0.1
                    }
                })
            }
        );

        const data = await response.json();

        const parsed = JSON.parse(
            data.candidates[0].content.parts[0].text
        );

        res.json(parsed);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Processing failed' });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
