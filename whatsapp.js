// whatsapp.js — WhatsApp cash expense recorder via Baileys

require("dotenv").config();

const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const supabase = require("./supabase");
const { classifyCategory } = require("./parser");

// --- Message parser ---

/**
 * Parse a WhatsApp message like:
 *   "makan siang 25000"
 *   "bensin 50rb"
 *   "kopi 15k"
 *   "grab 23.500"
 *
 * Returns { merchant, amount } or null
 */
function parseCashMessage(text) {
    text = text.trim();
    if (!text) return null;

    // Match: <description> <amount>
    // Amount can end with 'k', 'rb', 'ribu', or be plain number with optional dots
    const match = text.match(/^(.+?)\s+([\d.]+)\s*(k|rb|ribu)?$/i);
    if (!match) return null;

    const merchant = match[1].trim();
    let amountStr = match[2].replace(/\./g, ""); // remove dot separators
    let amount = parseFloat(amountStr);

    if (isNaN(amount) || amount <= 0) return null;

    // Handle multiplier suffixes
    const suffix = (match[3] || "").toLowerCase();
    if (suffix === "k" || suffix === "rb" || suffix === "ribu") {
        amount *= 1000;
    }

    return { merchant, amount: Math.round(amount) };
}

// --- Format currency ---
function formatRupiah(num) {
    if (num === null || num === undefined || isNaN(num)) {
        return "Rp 0";
    }
    return "Rp " + num.toLocaleString("id-ID");
}

// --- Save to Supabase ---
async function saveCashExpense(merchant, amount) {
    const row = {
        gmail_message_id: `wa-cash-${Date.now()}`, // unique ID for WA entries
        merchant,
        amount,
        category: classifyCategory(merchant),
        source: "Cash"
    };

    const { data, error } = await supabase
        .from("transactions")
        .insert(row)
        .select();

    if (error) {
        console.error("❌ Supabase error:", error.message);
        return null;
    }

    return data?.[0];
}

// --- WhatsApp connection ---
let retryCount = 0;
const MAX_RETRIES = 5;
let activeSock = null;

// --- Send notification to self-chat ---
async function sendWANotification(text) {
    if (!activeSock) {
        console.log("⚠️  WhatsApp not connected — skipping notification");
        return;
    }

    const selfJid = process.env.MY_LID
        ? `${process.env.MY_LID}@lid`
        : process.env.MY_PHONE
            ? `${process.env.MY_PHONE}@s.whatsapp.net`
            : null;

    if (!selfJid) {
        console.log("⚠️  MY_LID/MY_PHONE not set — skipping notification");
        return;
    }

    try {
        await activeSock.sendMessage(selfJid, { text });
    } catch (err) {
        console.error("❌ Failed to send WA notification:", err.message);
    }
}

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth_session");

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "silent" }),
        // Prevent message history download on connect (reduces 440 errors)
        syncFullHistory: false
    });

    // Save credentials on update
    sock.ev.on("creds.update", saveCreds);

    // Handle connection
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrcode = require("qrcode-terminal");
            qrcode.generate(qr, { small: true });
            console.log("\n📱 Scan QR code di atas dengan WhatsApp kamu\n");
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log("❌ Connection closed. Reason:", reason);

            if (shouldReconnect && retryCount < MAX_RETRIES) {
                retryCount++;
                const delay = Math.min(retryCount * 3000, 15000); // 3s, 6s, 9s, ... max 15s
                console.log(`🔄 Reconnecting in ${delay / 1000}s... (attempt ${retryCount}/${MAX_RETRIES})`);
                setTimeout(() => startWhatsApp(), delay);
            } else if (!shouldReconnect) {
                console.log("🚪 Logged out. Delete ./auth_session and restart to re-login.");
            } else {
                console.log("⛔ Max retries reached. Restart manually with: node whatsapp.js");
            }
        } else if (connection === "open") {
            retryCount = 0; // Reset on successful connection
            activeSock = sock; // Store active socket for notifications
            console.log("✅ WhatsApp connected!");
            console.log("📝 Kirim pesan dengan format: <keterangan> <nominal>");
        }
    });

    // Handle incoming messages
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
            // Only process messages sent by us
            if (msg.key.fromMe !== true) continue;
            if (msg.key.remoteJid === "status@broadcast") continue;

            // Only process messages in self-chat (chat with yourself)
            // WhatsApp uses two formats: phone@s.whatsapp.net (old) and xxx@lid (new)
            const myPhoneJid = process.env.MY_PHONE
                ? `${process.env.MY_PHONE}@s.whatsapp.net`
                : sock.user?.id?.replace(/:.*@/, "@s.whatsapp.net");
            const myLidJid = process.env.MY_LID
                ? `${process.env.MY_LID}@lid`
                : null;

            const rid = msg.key.remoteJid;
            const isSelfChat = rid === myPhoneJid || (myLidJid && rid === myLidJid);

            if (!isSelfChat) continue;

            // Get text content
            const text =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                "";

            if (!text) continue;

            // Check for help command
            if (text.toLowerCase() === "!h" || text.toLowerCase() === "!bantuan") {
                await sock.sendMessage(msg.key.remoteJid, {
                    text:
                        "📝 *Expense Recorder — Bantuan*\n\n" +
                        "Kirim pesan dengan format:\n" +
                        "`<keterangan> <nominal>`\n\n" +
                        "*Perintah Rekap:*\n" +
                        "• `!help` — Tampilkan bantuan\n" +
                        "• `!t` — Total pengeluaran hari ini\n" +
                        "• `!t<tanggal>` — Rincian tanggal tertentu di bulan ini (Contoh: `!t1`, `!t25`)\n" +
                        "• `!m` — Total pengeluaran bulanan dirangkum per hari\n"
                });
                continue;
            }

            // Check for today summary
            const targetMessage = text.toLowerCase().trim();
            if (/^!t(\d+)?$/.test(targetMessage)) {
                const match = targetMessage.match(/^!t(\d+)$/);
                const now = new Date();
                
                let targetDate = now.getDate(); // Default ke hari ini jika hanya !t
                let isSpecificDate = false;
            
                if (match) {
                    targetDate = parseInt(match[1], 10);
                    isSpecificDate = true;
                    
                    // Validasi input tanggal aman (1-31)
                    if (targetDate < 1 || targetDate > 31) {
                        await sock.sendMessage(msg.key.remoteJid, {
                            text: "❌ Tanggal tidak valid! Gunakan range !t1 sampai !t31."
                        });
                        continue;
                    }
                }
            
                // Set range waktu pencarian (00:00:00 sampai 23:59:59 pada tanggal target)
                const startOfTargetDay = new Date(now.getFullYear(), now.getMonth(), targetDate, 0, 0, 0, 0);
                const endOfTargetDay = new Date(now.getFullYear(), now.getMonth(), targetDate, 23, 59, 59, 999);
            
                const { data, error } = await supabase
                    .from("transactions")
                    .select("merchant, amount, source")
                    .gte("created_at", startOfTargetDay.toISOString())
                    .lte("created_at", endOfTargetDay.toISOString())
                    .order("created_at", { ascending: true });
            
                if (error) {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: `❌ Gagal ambil data tanggal ${targetDate}: ` + error.message
                    });
                    continue;
                }
            
                const formatJudul = isSpecificDate 
                    ? `Rincian Pengeluaran Tgl ${targetDate}/${now.getMonth() + 1}`
                    : `Pengeluaran Hari Ini`;
            
                if (!data || data.length === 0) {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: `📊 Belum ada data pengeluaran untuk ${formatJudul}.`
                    });
                    continue;
                }
            
                const total = data.reduce((sum, d) => sum + (d.amount || 0), 0);
                let summary = `📊 *${formatJudul}*\n\n`;
                
                data.forEach((d, i) => {
                    const src = d.source ? ` [${d.source}]` : "";
                    summary += `${i + 1}. ${d.merchant} — ${formatRupiah(d.amount)}${src}\n`;
                });
                summary += `\n💰 *Total: ${formatRupiah(total)}*`;
            
                await sock.sendMessage(msg.key.remoteJid, { text: summary });
                continue;
            }
            
            // Check for monthly summary
            if (text.toLowerCase() === "!m" || text.toLowerCase() === "!bulan") {
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            
                const { data, error } = await supabase
                    .from("transactions")
                    .select("amount, created_at")
                    .gte("created_at", startOfMonth.toISOString())
                    .order("created_at", { ascending: true });
            
                if (error) {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: "❌ Gagal ambil data bulanan: " + error.message
                    });
                    continue;
                }
            
                if (!data || data.length === 0) {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: "📊 Belum ada pengeluaran di bulan ini."
                    });
                    continue;
                }
            
                // Grouping total pengeluaran per tanggal
                const dailyTotals = {};
                let totalBulanIni = 0;
            
                data.forEach(d => {
                    const tgl = new Date(d.created_at).getDate();
                    const amt = d.amount || 0;
                    dailyTotals[tgl] = (dailyTotals[tgl] || 0) + amt;
                    totalBulanIni += amt;
                });
            
                const namaBulan = now.toLocaleString("id-ID", { month: "long", year: "numeric" });
                let summary = `📊 *Total Pengeluaran Per Hari (${namaBulan})*\n\n`;
                
                // Looping berdasarkan tanggal yang ada transaksinya
                Object.keys(dailyTotals).forEach(tgl => {
                    summary += `• Tgl ${tgl}: ${formatRupiah(dailyTotals[tgl])}\n`;
                });
                
                summary += `\n💰 *Total Bulan Ini: ${formatRupiah(totalBulanIni)}*`;
                summary += `\n\n💡 _Ketik ` + "`!t<tanggal>`" + ` untuk melihat rincian (Contoh: ` + "`!t9`" + `)_`;
            
                await sock.sendMessage(msg.key.remoteJid, { text: summary });
                continue;
            }

            // Parse expense message
            const expense = parseCashMessage(text);
            if (!expense) continue; // Not an expense format, ignore

            console.log(`💸 Expense: ${expense.merchant} — ${formatRupiah(expense.amount)}`);

            const saved = await saveCashExpense(expense.merchant, expense.amount);

            if (saved) {
                await sock.sendMessage(msg.key.remoteJid, {
                    text:
                        `✅ *Tercatat!*\n\n` +
                        `📌 ${expense.merchant}\n` +
                        `💰 ${formatRupiah(expense.amount)}\n`
                });
            } else {
                await sock.sendMessage(msg.key.remoteJid, {
                    text: "❌ Gagal menyimpan. Coba lagi."
                });
            }
        }
    });
}

module.exports = { startWhatsApp, sendWANotification, formatRupiah };
