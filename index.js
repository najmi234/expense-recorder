require("dotenv").config();

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const supabase = require("./supabase");
const { parseMandiriEmail } = require("./parser");
const { sendWANotification, formatRupiah } = require("./whatsapp");

const MANDIRI_SENDERS = ["noreply.livin@bankmandiri.co.id"];

// ✅ Track last processed UID to avoid missing emails
let lastProcessedUid = 0;

// ✅ Polling interval (1 menit)
const POLL_INTERVAL_MS = 60 * 1000;

function createClient() {
    return new ImapFlow({
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: {
            user: process.env.EMAIL,
            pass: process.env.EMAIL_PASSWORD
        },
        logger: false,
        emitLogs: false,
        tls: {
            rejectUnauthorized: false
        }
    });
}

function isMandiriEmail(parsed) {
    const from = parsed.from?.value?.[0]?.address?.toLowerCase() || "";
    if (MANDIRI_SENDERS.some(s => from.includes(s))) return true;
    const subject = (parsed.subject || "").toLowerCase();
    const fromText = (parsed.from?.text || "").toLowerCase();
    return (
        subject.includes("mandiri") ||
        subject.includes("pembayaran berhasil") ||
        fromText.includes("mandiri")
    );
}

async function saveToSupabase(data, messageId) {
    const row = {
        gmail_message_id: messageId,
        merchant: data.merchant,
        amount: data.amount,
        category: data.category || "Lainnya",
        source: data.source
    };

    const { data: existing } = await supabase
        .from("transactions")
        .select("id")
        .eq("gmail_message_id", messageId)
        .maybeSingle();

    if (existing) {
        console.log("⏭️  Already saved (id:", existing.id, ") — skipping");
        return existing;
    }

    const { data: inserted, error } = await supabase
        .from("transactions")
        .insert(row)
        .select();

    if (error) {
        console.error("❌ Supabase error:", error.message);
        return null;
    }

    console.log("✅ Saved to Supabase:", inserted);
    return inserted;
}

/**
 * Connect, check for new emails, process them, disconnect.
 * Short-lived connection — no ECONNRESET issues.
 */
async function pollForEmails() {
    const client = createClient();

    try {
        await client.connect();
        const mailbox = await client.mailboxOpen("INBOX");

        // First run: set starting UID from current mailbox
        if (lastProcessedUid === 0) {
            lastProcessedUid = mailbox.uidNext - 1;
            console.log(`  📌 Starting from UID: ${lastProcessedUid}`);
            return; // First run — don't process old emails
        }

        // Fetch all messages with UID > lastProcessedUid
        const searchQuery = { uid: `${lastProcessedUid + 1}:*` };

        const messages = [];
        for await (const msg of client.fetch(searchQuery, {
            uid: true,
            source: true,
            envelope: true
        })) {
            if (msg.uid <= lastProcessedUid) continue;
            messages.push(msg);
        }

        if (messages.length === 0) return;

        console.log(`\n📩 Processing ${messages.length} new email(s)...`);

        for (const message of messages) {
            try {
                const parsed = await simpleParser(message.source);
                const messageId = message.envelope.messageId || `uid-${message.uid}`;

                console.log(`\n  📧 UID ${message.uid}:`);
                console.log("  From   :", parsed.from?.text);
                console.log("  Subject:", parsed.subject);

                const subject = (parsed.subject || "").toLowerCase();
                if (
                    subject.includes("tidak berhasil") ||
                    subject.includes("gagal") ||
                    subject.includes("failed") ||
                    subject.includes("declined")
                ) {
                    console.log("  ⏭️  Pembayaran tidak berhasil — skipping");
                    lastProcessedUid = Math.max(lastProcessedUid, message.uid);
                    continue;
                }

                if (!isMandiriEmail(parsed)) {
                    console.log("  ⏭️  Not a Mandiri email — skipping");
                    lastProcessedUid = Math.max(lastProcessedUid, message.uid);
                    continue;
                }

                console.log("  🏦 Mandiri email detected — parsing...");
                const data = parseMandiriEmail(parsed);

                if (!data) {
                    console.log("  ⚠️  Could not parse transaction data");
                    lastProcessedUid = Math.max(lastProcessedUid, message.uid);
                    continue;
                }

                console.log("  📊 Parsed:", JSON.stringify(data, null, 2));
                await saveToSupabase(data, messageId);

                await sendWANotification(
                    `🏦 *Pembayaran QRIS Tercatat!*\n\n` +
                    `📌 ${data.merchant}\n` +
                    `💰 ${formatRupiah(data.amount)}\n` +
                    `📡 ${data.source}`
                );

                lastProcessedUid = Math.max(lastProcessedUid, message.uid);
            } catch (err) {
                console.error(`❌ Error processing UID ${message.uid}:`, err.message);
                lastProcessedUid = Math.max(lastProcessedUid, message.uid);
            }
        }
    } catch (err) {
        console.error("❌ Gmail poll error:", err.message);
    } finally {
        // ✅ Selalu tutup koneksi — tidak ada koneksi yang menggantung
        try { await client.logout(); } catch (_) { }
    }
}

/**
 * Start Gmail polling loop.
 * Connect → check → disconnect → wait → repeat.
 */
async function start() {
    console.log(`📬 Gmail polling started (every ${POLL_INTERVAL_MS / 1000}s)`);

    // Initial poll
    await pollForEmails();

    // Schedule recurring polls
    setInterval(async () => {
        try {
            await pollForEmails();
        } catch (err) {
            console.error("❌ Poll cycle error:", err.message);
        }
    }, POLL_INTERVAL_MS);
}

module.exports = { start };