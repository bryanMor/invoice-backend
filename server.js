const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());

function extractMasterCase(rawLine) {
    const csMatch = rawLine.match(/CS(\d{6})/);
    return csMatch ? parseInt(csMatch[1]) : null;
}

function extractQtyOrdered(rawLine) {
    const qtyMatch = rawLine.match(/\+(\d{4})/);
    return qtyMatch ? parseInt(qtyMatch[1]) : 1;
}

function calculateUnitsPerCase(description, rawLine) {
    if (!description) return 1;

    const desc = description.toUpperCase();

    // 1️⃣ X/Y pattern (2/15 PACK)
    const slashMatch = desc.match(/(\d+)\s*\/\s*(\d+)/);
    if (slashMatch) {
        return parseInt(slashMatch[1]);
    }

    const masterCaseSize = extractMasterCase(rawLine);

    // 2️⃣ PK pattern (6PK, 12PK, etc.)
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

    // 3️⃣ If no hierarchy
    return 1;
}

app.post("/api/extract", (req, res) => {
    try {
        const { items } = req.body;

        const processedItems = items.map(item => {

            const masterCaseSize = extractMasterCase(item.rawLine);
            const qtyOrdered = extractQtyOrdered(item.rawLine);
            const unitsPerCase = calculateUnitsPerCase(
                item.description,
                item.rawLine
            );

            return {
                description: item.description,
                masterCaseSize,
                unitsPerCase,
                qtyOrdered
            };
        });

        res.json({ items: processedItems });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

app.listen(3000, () => {
    console.log("Server running on port 3000");
});
