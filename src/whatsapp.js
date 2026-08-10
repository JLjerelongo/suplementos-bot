require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { crearSocket, numeroAJid } = require("./whatsapp-client");

const storageDir =
  process.env.STORAGE_DIR || path.join(process.cwd(), "storage");

function dinero(valor) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(valor);
}

function construirMensaje(cambios) {
  const lineas = [
    "🔔 CAMBIOS DE PRECIOS",
    "",
    `Se detectaron ${cambios.length} cambio(s):`,
    "",
  ];

  for (const cambio of cambios) {
    const emoji = cambio.tipo === "AUMENTO" ? "📈" : "📉";

    const porcentaje =
      cambio.porcentaje === null
        ? "N/D"
        : `${cambio.porcentaje}%`;

    lineas.push(
      `${emoji} ${cambio.producto}`,
      `Anterior: ${dinero(cambio.anterior)}`,
      `Nuevo: ${dinero(cambio.actual)}`,
      `Cambio: ${
        cambio.diferencia >= 0 ? "+" : ""
      }${dinero(cambio.diferencia)} (${porcentaje})`,
      ""
    );
  }

  lineas.push(`🕒 ${new Date().toLocaleString("es-AR")}`);

  return lineas.join("\n");
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function obtenerCodigoDesconexion(lastDisconnect) {
  return lastDisconnect?.error?.output?.statusCode ?? null;
}

async function enviarUnaVez(cambios, intento, maxIntentos) {
  console.log(
    `→ Iniciando conexión de WhatsApp (intento ${intento}/${maxIntentos})...`
  );

  const { sock, DisconnectReason } = await crearSocket({
    // Nunca mostrar QR durante el check automático.
    mostrarQR: false,
  });

  const destino = numeroAJid(process.env.WHATSAPP_TO);

  return new Promise((resolve, reject) => {
    let terminado = false;

    const timeout = setTimeout(() => {
      if (terminado) return;

      terminado = true;

      try {
        sock.end(undefined);
      } catch (_) {}

      reject(
        new Error(
          "Timeout esperando que WhatsApp quedara conectado."
        )
      );
    }, 60000);

    const finalizar = (fn, valor) => {
      if (terminado) return;

      terminado = true;
      clearTimeout(timeout);

      fn(valor);
    };

    sock.ev.on(
      "connection.update",
      async ({ connection, lastDisconnect }) => {
        /*
         * IMPORTANTE:
         *
         * No usamos autenticado.
         *
         * La única señal que necesitamos para saber que podemos
         * enviar es connection === "open".
         */
        if (connection === "open") {
          try {
            console.log("✓ WhatsApp conectado.");
            console.log(`→ Enviando cambios (intento ${intento}/${maxIntentos})...`);

            const mensaje = construirMensaje(cambios);

            const result = await sock.sendMessage(destino, {
              text: mensaje,
            });

            console.log("✓ Mensaje de WhatsApp enviado.");
            console.log(`✓ ID: ${result?.key?.id || "N/D"}`);

            /*
             * Esperamos un poco para permitir que Baileys termine
             * de procesar/transmitir el mensaje antes de cerrar.
             */
            await esperar(5000);

            finalizar(resolve);

            try {
              sock.end(undefined);
            } catch (_) {}
          } catch (error) {
            finalizar(reject, error);

            try {
              sock.end(undefined);
            } catch (_) {}
          }

          return;
        }

        if (connection === "close" && !terminado) {
          const code = obtenerCodigoDesconexion(lastDisconnect);

          console.error(
            `⚠️ WhatsApp cerró la conexión${
              code ? ` (código ${code})` : ""
            }`
          );

          /*
           * 401 = sesión cerrada por WhatsApp.
           * En ese caso los reintentos no sirven.
           */
          if (code === DisconnectReason.loggedOut) {
            finalizar(
              reject,
              new Error(
                "WhatsApp cerró la sesión. Ejecutá npm run whatsapp:login para volver a vincular."
              )
            );

            return;
          }

          finalizar(
            reject,
            new Error(
              `WhatsApp cerró la conexión${
                code ? ` (código ${code})` : ""
              }.`
            )
          );
        }
      }
    );
  });
}

async function enviarMensaje(cambios) {
  if (!cambios || cambios.length === 0) {
    console.log("No hay cambios. No se enviará WhatsApp.");
    return;
  }

  const to = process.env.WHATSAPP_TO;

  if (!to) {
    throw new Error("Falta WHATSAPP_TO en .env.");
  }

  const maxIntentos = 3;
  let ultimoError;

  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      await enviarUnaVez(
        cambios,
        intento,
        maxIntentos
      );

      return;
    } catch (error) {
      ultimoError = error;

      console.error(
        `⚠️ Error en WhatsApp (intento ${intento}/${maxIntentos}):`,
        error.message
      );

      if (intento < maxIntentos) {
        console.log(
          "→ Reintentando en 5 segundos..."
        );

        await esperar(5000);
      }
    }
  }

  throw new Error(
    `No se pudo enviar WhatsApp después de ${maxIntentos} intentos: ${
      ultimoError?.message || "error desconocido"
    }`
  );
}

async function main() {
  const changesPath = path.join(
    storageDir,
    "price-changes.json"
  );

  try {
    const raw = await fs.readFile(
      changesPath,
      "utf8"
    );

    const data = JSON.parse(raw);

    await enviarMensaje(data.cambios || []);
  } catch (error) {
    console.error("\n❌ Error de WhatsApp:");
    console.error(error.stack || error.message);

    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  enviarMensaje,
  construirMensaje,
};