const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
const CURRENT_PATH = path.join(DATA_DIR, "products.json");
const PREVIOUS_PATH = path.join(STORAGE_DIR, "previous-products.json");
const CHANGES_PATH = path.join(STORAGE_DIR, "price-changes.json");

function redondear(numero, decimales = 2) {
  const factor = 10 ** decimales;
  return Math.round(numero * factor) / factor;
}

async function leerJSON(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function indexarProductos(productos) {
  return new Map(
    productos.map((producto) => {
      // La URL es el identificador más estable que tenemos.
      // Si no existe, usamos el objetivo configurado.
      const key = producto.url || producto.objetivo;
      return [key, producto];
    })
  );
}

function compararProductos(actuales, anteriores) {
  const mapaActual = indexarProductos(actuales);
  const mapaAnterior = indexarProductos(anteriores);

  const cambios = [];
  const nuevos = [];
  const eliminados = [];

  for (const [key, actual] of mapaActual) {
    const anterior = mapaAnterior.get(key);

    if (!anterior) {
      nuevos.push({
        producto: actual.nombre,
        precio: actual.precio,
        url: actual.url,
      });
      continue;
    }

    if (Number(actual.precio) !== Number(anterior.precio)) {
      const diferencia = Number(actual.precio) - Number(anterior.precio);
      const porcentaje =
        anterior.precio > 0 ? (diferencia / anterior.precio) * 100 : null;

      cambios.push({
        producto: actual.nombre,
        url: actual.url,
        anterior: Number(anterior.precio),
        actual: Number(actual.precio),
        diferencia,
        porcentaje:
          porcentaje === null ? null : redondear(porcentaje),
        tipo: diferencia > 0 ? "AUMENTO" : "BAJA",
      });
    }
  }

  for (const [key, anterior] of mapaAnterior) {
    if (!mapaActual.has(key)) {
      eliminados.push({
        producto: anterior.nombre,
        precioAnterior: anterior.precio,
        url: anterior.url,
      });
    }
  }

  return { cambios, nuevos, eliminados };
}

async function main() {
  console.log("========================================");
  console.log("       COMPARADOR DE PRECIOS");
  console.log("========================================\n");

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  const actual = await leerJSON(CURRENT_PATH);

  if (!actual || !Array.isArray(actual.products)) {
    throw new Error(
      "No existe data/products.json válido. Ejecutá primero: npm run scrape"
    );
  }

  const anterior = await leerJSON(PREVIOUS_PATH);

  // Seguridad: si el scraper no encontró todos los productos monitoreados,
  // NO actualizamos la referencia. Así una caída/cambio de la web no se
  // interpreta como una baja o eliminación de productos.
  if (
    Number(actual.foundCount) !== Number(actual.monitoredCount) ||
    (Array.isArray(actual.missing) && actual.missing.length > 0)
  ) {
    throw new Error(
      `Scraping incompleto: encontrados ${actual.foundCount}/${actual.monitoredCount}. ` +
      `No se actualizará la referencia de precios. Faltantes: ${
        actual.missing?.join(", ") || "N/D"
      }`
    );
  }

  // Primera ejecución: no podemos afirmar que hubo un cambio.
  if (!anterior || !Array.isArray(anterior.products)) {
    await fs.writeFile(
      PREVIOUS_PATH,
      JSON.stringify(actual, null, 2),
      "utf8"
    );

    const resultado = {
      primeraEjecucion: true,
      cambios: [],
      nuevos: actual.products.map((p) => ({
        producto: p.nombre,
        precio: p.precio,
        url: p.url,
      })),
      eliminados: [],
    };

    await fs.writeFile(
      CHANGES_PATH,
      JSON.stringify(resultado, null, 2),
      "utf8"
    );

    console.log("Primera ejecución detectada.");
    console.log(
      "Se guardaron los precios actuales como referencia."
    );
    console.log(
      "Todavía NO se consideran cambios de precio."
    );
    return;
  }

  const resultado = compararProductos(actual.products, anterior.products);

  await fs.writeFile(
    CHANGES_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...resultado,
      },
      null,
      2
    ),
    "utf8"
  );

  // Actualizamos la referencia después de comparar.
  await fs.writeFile(
    PREVIOUS_PATH,
    JSON.stringify(actual, null, 2),
    "utf8"
  );

  console.log(`Productos actuales: ${actual.products.length}`);
  console.log(`Cambios de precio: ${resultado.cambios.length}`);
  console.log(`Productos nuevos: ${resultado.nuevos.length}`);
  console.log(`Productos que ya no aparecen: ${resultado.eliminados.length}`);

  if (resultado.cambios.length > 0) {
    console.log("\n🔔 CAMBIOS DETECTADOS:\n");

    console.table(
      resultado.cambios.map((cambio) => ({
        Producto: cambio.producto,
        Anterior: cambio.anterior,
        Actual: cambio.actual,
        Diferencia: cambio.diferencia,
        "Cambio %":
          cambio.porcentaje === null
            ? "N/D"
            : `${cambio.porcentaje}%`,
        Tipo: cambio.tipo,
      }))
    );
  } else {
    console.log("\n✓ No hubo cambios de precio.");
  }
}

module.exports = { compararProductos, leerJSON };

main().catch((error) => {
  console.error("\n❌ Error en el comparador:");
  console.error(error.message);
  process.exitCode = 1;
});
