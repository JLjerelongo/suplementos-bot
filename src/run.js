const { spawn } = require("child_process");

function ejecutar(comando, args) {
  return new Promise((resolve, reject) => {
    const proceso = spawn(comando, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    proceso.on("error", reject);

    proceso.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${comando} terminó con código ${code}`));
        return;
      }

      resolve();
    });
  });
}

async function main() {
  console.log("========================================");
  console.log("       SUPLEMENTOS - CHECK COMPLETO");
  console.log("========================================\n");

  console.log("1/3 → Scraping");
  await ejecutar("node", ["src/scraper.js"]);

  console.log("\n2/3 → Comparación");
  await ejecutar("node", ["src/comparator.js"]);

  // La primera ejecución crea price-changes.json sin cambios.
  // whatsapp.js simplemente no envía nada si cambios está vacío.
  console.log("\n3/3 → WhatsApp");
  await ejecutar("node", ["src/whatsapp.js"]);

  console.log("\n✓ Proceso completo finalizado.");
}

main().catch((error) => {
  console.error("\n❌ Error en el proceso completo:");
  console.error(error.message);
  process.exitCode = 1;
});
