require("dotenv").config();

const { crearSocket } = require("./whatsapp-client");

async function main() {
  console.log("Iniciando WhatsApp...");
  console.log(`→ Node: ${process.version}`);
  console.log("→ Motor: Baileys (sin Puppeteer/Chrome)");

  const { sock, DisconnectReason, authDir } = await crearSocket({
    mostrarQR: true,
  });

  let cerrado = false;

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      console.log("\n✅ WhatsApp quedó vinculado y listo.");
      console.log(`✓ Sesión guardada en: ${authDir}`);
      console.log("✓ Ya podés cerrar este proceso con Ctrl+C.");
    }

    if (connection === "close" && !cerrado) {
      cerrado = true;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("❌ WhatsApp cerró la sesión. Hay que volver a vincular.");
      } else {
        console.error(`❌ Conexión cerrada. Código: ${code || "N/D"}`);
      }
      process.exitCode = 1;
    }
  });
}

main().catch((error) => {
  console.error("\n❌ Error de WhatsApp:");
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
