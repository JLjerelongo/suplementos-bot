require("dotenv").config();

const { crearSocket } = require("./whatsapp-client");

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("Iniciando WhatsApp...");
  console.log(`→ Node: ${process.version}`);
  console.log("→ Motor: Baileys (sin Puppeteer/Chrome)");

  const { sock, DisconnectReason } = await crearSocket({
    mostrarQR: true,
  });

  let ready = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "open" && !ready) {
      ready = true;
      console.log("✓ WhatsApp conectado.");

      const propio = sock.user?.id;
      if (!propio) {
        throw new Error("WhatsApp conectó pero no informó el ID de la cuenta.");
      }

      console.log(`✓ Cuenta conectada: ${propio}`);
      console.log(`→ Enviando mensaje de prueba a: ${propio}`);

      try {
        const result = await sock.sendMessage(propio, {
          text:
            "🧪 PRUEBA - Suplementos Bot\n\n" +
            "WhatsApp está correctamente conectado.\n" +
            `Hora: ${new Date().toLocaleString("es-AR")}`,
        });

        console.log("✓ Mensaje enviado a WhatsApp.");
        console.log(`✓ ID: ${result?.key?.id || "N/D"}`);
        console.log("📱 Revisá tu WhatsApp.");
      } catch (error) {
        console.error("❌ Error enviando el mensaje:");
        console.error(error.stack || error.message);
        process.exitCode = 1;
      }

      // Dejamos unos segundos para que el socket confirme el envío.
      await esperar(5000);
      sock.end(undefined);
      process.exit(process.exitCode || 0);
    }

    if (connection === "close" && !ready) {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("❌ La sesión fue cerrada por WhatsApp. Volvé a vincular con npm run whatsapp:login.");
      } else {
        console.error(`❌ WhatsApp se desconectó antes del envío. Código: ${code || "N/D"}`);
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
