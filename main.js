// main.js — Single entry point for Gmail + WhatsApp listeners

require("dotenv").config();

const { start: startGmail } = require("./index");
const { startWhatsApp } = require("./whatsapp");

async function main() {
    console.log("🚀 Starting Expense Recorder...\n");

    // Run both services concurrently
    await Promise.all([
        startGmail().then(() => console.log("📬 Gmail listener active")),
        startWhatsApp().then(() => console.log("📱 WhatsApp listener active"))
    ]);
}

main().catch(console.error);
