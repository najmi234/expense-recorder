// parser.js — Parse Mandiri (Livin' by Mandiri) transaction emails

/**
 * Parse a Mandiri transaction email and extract structured data.
 * Works with both HTML and plain-text bodies.
 *
 * @param {object} parsed - Output from mailparser's simpleParser
 * @returns {object|null} Parsed transaction data, or null if not parseable
 */
function parseMandiriEmail(parsed) {
    let text = parsed.text;

    if (!text && parsed.html) {
        text = parsed.html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/?(p|div|tr|td|th|table|tbody|thead)[^>]*>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&#8203;/g, "")
            .replace(/\r\n/g, "\n");
    }

    if (!text) return null;

    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const blob = lines.join("\n");

    // ✅ Double-check dari body email
    const subjectLower = (parsed.subject || "").toLowerCase();
    const bodyLower = blob.toLowerCase();

    const isFailed =
        subjectLower.includes("tidak berhasil") ||
        subjectLower.includes("gagal") ||
        subjectLower.includes("failed") ||
        bodyLower.includes("transaksi gagal") ||
        bodyLower.includes("pembayaran tidak berhasil") ||
        bodyLower.includes("tidak dapat diproses");

    if (isFailed) {
        console.log("  ⛔ Transaksi gagal terdeteksi di body — skipping");
        return null;
    }

    const merchant = extract(blob, /Penerima\s*[\n:]\s*(.+)/i);
    const nominalRaw = extract(blob, /Nominal Transaksi\s*[\n:]\s*(.+)/i);
    const amount = parseAmount(nominalRaw);
    const source = extractSource(blob);

    if (!merchant && !amount) return null;

    return {
        merchant: merchant || "Unknown",
        amount,
        category: classifyCategory(merchant),
        source: source || "Livin' by Mandiri"
    };
}

// ---- Helper functions ----

function extract(text, regex) {
    const m = text.match(regex);
    if (!m) return null;
    return m[1].trim();
}


function parseAmount(raw) {
    if (!raw) return null;
    // "Rp 43.000,00" → 43000
    const cleaned = raw
        .replace(/[Rr]p\.?\s*/g, "")
        .replace(/\./g, "")       // thousand separators
        .replace(/,\d{2}$/, "");  // remove cents
    const num = parseInt(cleaned, 10);
    return isNaN(num) ? null : num;
}

function extractSource(text) {
    if (/QRIS/i.test(text)) return "QRIS";
    if (/transfer/i.test(text)) return "Transfer";
    if (/GoPay/i.test(text)) return "GoPay";
    if (/OVO/i.test(text)) return "OVO";
    if (/DANA/i.test(text)) return "DANA";
    if (/Sumber Dana/i.test(text)) return "QRIS";
    return "Livin' by Mandiri";
}

// --- Auto-classify category from merchant name ---
const FOOD_KEYWORDS = [
    "makan", "nasi", "ayam", "bakso", "mie", "mi ", "sate", "soto",
    "gado", "pecel", "rawon", "rendang", "gudeg", "geprek", "gepruk",
    "warteg", "warung", "resto", "restaurant", "cafe", "kafe",
    "coffee", "kopi", "starbucks", "mcd", "mcdonald", "kfc",
    "burger", "pizza", "roti", "bakery", "toko roti",
    "jus", "juice", "es ", "teh ", "susu", "boba", "chatime",
    "martabak", "gorengan", "snack", "cemilan", "jajan",
    "dadar", "indomie", "sambel", "sambal", "lalapan",
    "seafood", "ikan", "udang", "cumi", "kepiting",
    "dimsum", "sushi", "ramen", "padang", "sunda",
    "air ", "air mineral", "aqua", "minum", "minuman",
    "food", "eat", "ricebox", "rice box", "catering",
    "hokben", "yoshinoya", "solaria", "recheese", "mixue",
    "kebab", "shawarma", "donat", "donut", "pancake",
    "cireng", "batagor", "siomay", "pempek", "empek",
    "bubur", "ketoprak", "lontong", "kupat", "tahu", "tempe",
];

const TRANSPORT_KEYWORDS = [
    "bensin", "solar", "pertamax", "pertalite", "pertamina",
    "shell", "spbu", "bbm", "fuel",
    "parkir", "parking", "tol", "toll",
    "grab", "gojek", "gocar", "goride", "uber",
    "ojek", "ojol", "taxi", "taksi", "angkot",
    "bus ", "kereta", "krl", "mrt", "lrt", "transjakarta", "tj ",
    "tiket", "ticket", "pesawat", "flight",
    "transport", "travel", "ongkir", "ongkos",
];

function classifyCategory(merchant) {
    if (!merchant) return "Lainnya";
    const lower = " " + merchant.toLowerCase() + " ";

    for (const kw of FOOD_KEYWORDS) {
        if (lower.includes(kw)) return "Makanan & Minuman";
    }
    for (const kw of TRANSPORT_KEYWORDS) {
        if (lower.includes(kw)) return "Transportasi";
    }
    return "Lainnya";
}

module.exports = { parseMandiriEmail, classifyCategory };
