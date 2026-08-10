const path = require("path");
const fs = require("fs");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

let baileysPromise;

async function getBaileys() {
  if (!baileysPromise) {
    baileysPromise = import("@whiskeysockets/baileys");
  }

  return baileysPromise;
}

function authDir() {
  return path.join(
    process.env.STORAGE_DIR || path.join(process.cwd(), "storage"),
    "baileys_auth"
  );
}

async function obtenerVersionWhatsApp() {
  const { fetchLatestWaWebVersion } = await getBaileys();

  try {
    const resultado = await fetchLatestWaWebVersion();

    if (resultado?.version) {
      console.log(
        `→ WhatsApp Web version: ${resultado.version.join(".")} ` +
        `(actual: ${resultado.isLatest ? "sí" : "no"})`
      );

      return resultado.version;
    }
  } catch (error) {
    console.warn(
      "⚠️ No se pudo obtener automáticamente la versión de WhatsApp Web."
    );
    console.warn(`→ ${error.message}`);
  }

  return undefined;
}

async function crearSocket({ mostrarQR = true } = {}) {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
  } = await getBaileys();

  const dir = authDir();

  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);

  console.log("→ Motor: Baileys (sin Puppeteer/Chrome)");

  const version = await obtenerVersionWhatsApp();

  const opciones = {
    auth: state,

    printQRInTerminal: false,

    logger: pino({
      level: "silent",
    }),

    markOnlineOnConnect: false,

    syncFullHistory: false,

    connectTimeoutMs: 60000,

    defaultQueryTimeoutMs: 60000,

    keepAliveIntervalMs: 25000,
  };

  if (version) {
    opciones.version = version;
  }

  const sock = makeWASocket(opciones);

  sock.ev.on("creds.update", saveCreds);

  if (mostrarQR) {
    sock.ev.on("connection.update", ({ qr }) => {
      if (qr) {
        console.log("\n📱 ESCANEÁ ESTE QR CON WHATSAPP\n");

        qrcode.generate(qr, {
          small: true,
        });

        console.log(
          "\nWhatsApp → Dispositivos vinculados → Vincular dispositivo.\n"
        );
      }
    });
  }

  return {
    sock,
    DisconnectReason,
    authDir: dir,
    autenticado: Boolean(state.creds?.registered),
  };
}

function numeroAJid(numero) {
  const limpio = String(numero || "").replace(/[^\d]/g, "");

  if (!limpio) {
    throw new Error("WHATSAPP_TO está vacío.");
  }

  return `${limpio}@s.whatsapp.net`;
}

module.exports = {
  crearSocket,
  numeroAJid,
  authDir,
};