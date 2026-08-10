const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs/promises");
const path = require("path");

const BASE_URL = "https://suplementoscolomayorista.com.ar";
const SHOP_URL = `${BASE_URL}/tienda/`;
const CONFIG_PATH = path.join(process.cwd(), "data", "monitored-products.json");
const OUTPUT_PATH = path.join(process.cwd(), "data", "products.json");

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
  },
});

function normalizarTexto(texto) {
  return (texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[-–—]/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizarPrecio(texto) {
  if (!texto) return null;

  const matches = texto.match(/\$?\s*[\d.]+(?:,\d+)?/g);
  if (!matches || matches.length === 0) return null;

  const ultimo = matches[matches.length - 1];

  const limpio = ultimo
    .replace(/\$/g, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const numero = Number(limpio);
  return Number.isFinite(numero) ? numero : null;
}

function productoCoincide(nombreWeb, objetivo) {
  const web = normalizarTexto(nombreWeb);

  const nombresValidos = [
    objetivo.name,
    ...(objetivo.aliases || []),
  ].map(normalizarTexto);

  // IMPORTANTE:
  // No usamos includes() para identificar productos porque podría confundir
  // "CREATINA ... 300G" con "CAJA CERRADA ... 14U".
  // Solamente aceptamos coincidencia exacta con el nombre configurado
  // o con uno de sus aliases.
  return nombresValidos.includes(web);
}

function extraerProductosDeListado(html) {
  const $ = cheerio.load(html);
  const productos = [];

  $(".products .product, ul.products li.product, li.product").each((_, el) => {
    const item = $(el);

    const nombre = item
      .find(".woocommerce-loop-product__title, .product-title")
      .first()
      .text()
      .trim();

    const url =
      item.find("a.woocommerce-LoopProduct-link, a").first().attr("href") ||
      null;

    const precioTexto = item.find(".price").first().text().trim();
    const precio = normalizarPrecio(precioTexto);

    if (!nombre || !url || precio === null) return;

    productos.push({
      nombre,
      precio,
      url: new URL(url, BASE_URL).href,
    });
  });

  return productos;
}

function detectarSiguientePagina(html, paginaActual) {
  const $ = cheerio.load(html);

  const next = $("a.next, a.next.page-numbers").first().attr("href");
  if (next) return new URL(next, BASE_URL).href;

  const links = $("a.page-numbers")
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter(Boolean);

  const paginas = links
    .map((url) => {
      const match = url.match(/\/page\/(\d+)\/?$/);
      return match ? Number(match[1]) : null;
    })
    .filter(Boolean);

  const maxPagina = paginas.length ? Math.max(...paginas) : paginaActual;

  if (maxPagina > paginaActual) {
    return `${BASE_URL}/tienda/page/${paginaActual + 1}/`;
  }

  return null;
}

async function cargarConfiguracion() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);

  if (!Array.isArray(config.products) || config.products.length === 0) {
    throw new Error("data/monitored-products.json no contiene productos.");
  }

  return config.products;
}

async function extraerProductosDePagina(url) {
  const response = await http.get(url);
  return extraerProductosDeListado(response.data);
}

async function encontrarProductosMonitoreados(objetivos) {
  const encontrados = [];
  const encontradosKeys = new Set();

  // Agrupamos por URL de categoría. Para productos con categoryUrl,
  // solamente consultamos esa categoría.
  const grupos = new Map();

  for (const objetivo of objetivos) {
    const origen = objetivo.categoryUrl || SHOP_URL;

    if (!grupos.has(origen)) grupos.set(origen, []);
    grupos.get(origen).push(objetivo);
  }

  for (const [origen, objetivosGrupo] of grupos.entries()) {
    const objetivosPendientes = new Map(
      objetivosGrupo.map((o) => [o.name, o])
    );

    const visitadas = new Set();
    let pagina = 1;
    let url = origen;

    while (url && !visitadas.has(url) && objetivosPendientes.size > 0) {
      visitadas.add(url);

      console.log(`→ Revisando: ${url}`);

      const productos = await extraerProductosDePagina(url);

      for (const [nombreObjetivo, objetivo] of objetivosPendientes) {
        // Coincidencia exacta o por alias. Nunca por substring.
        const candidato = productos.find((producto) =>
          productoCoincide(producto.nombre, objetivo)
        );

        if (!candidato) continue;

        const key = `${objetivo.name}|${candidato.url}`;

        if (!encontradosKeys.has(key)) {
          encontradosKeys.add(key);

          encontrados.push({
            objetivo: objetivo.name,
            brand: objetivo.brand,
            nombre: candidato.nombre,
            precio: candidato.precio,
            url: candidato.url,
            sku: null,
          });
        }

        objetivosPendientes.delete(nombreObjetivo);
      }

      if (objetivosPendientes.size === 0) break;

      const siguiente = detectarSiguientePagina(
        (await http.get(url)).data,
        pagina
      );

      if (!siguiente || siguiente === url) break;

      url = siguiente;
      pagina += 1;

      await dormir(700);
    }
  }

  return encontrados;
}

async function obtenerSKU(url) {
  try {
    const response = await http.get(url);
    const $ = cheerio.load(response.data);

    const sku =
      $(".sku").first().text().trim() ||
      $(".product_meta .sku").first().text().trim() ||
      null;

    return sku || null;
  } catch {
    return null;
  }
}

async function completarSKUs(productos) {
  for (let i = 0; i < productos.length; i++) {
    const producto = productos[i];

    console.log(
      `[${i + 1}/${productos.length}] Consultando: ${producto.nombre}`
    );

    producto.sku = await obtenerSKU(producto.url);
    await dormir(500);
  }

  return productos;
}

async function guardarProductos(productos, objetivos) {
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });

  const encontrados = new Set(productos.map((p) => p.objetivo));
  const faltantes = objetivos
    .filter((o) => !encontrados.has(o.name))
    .map((o) => o.name);

  const contenido = {
    scrapedAt: new Date().toISOString(),
    source: BASE_URL,
    monitoredCount: objetivos.length,
    foundCount: productos.length,
    missing: faltantes,
    products: productos,
  };

  await fs.writeFile(
    OUTPUT_PATH,
    JSON.stringify(contenido, null, 2),
    "utf8"
  );

  return faltantes;
}

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("========================================");
  console.log("   SUPLEMENTOS - MONITORED PRICE BOT");
  console.log("========================================\n");

  try {
    const objetivos = await cargarConfiguracion();

    console.log(`Productos configurados: ${objetivos.length}\n`);

    const encontrados = await encontrarProductosMonitoreados(objetivos);

    if (encontrados.length === 0) {
      throw new Error(
        "No se encontró ningún producto configurado. La estructura o los nombres de la web pueden haber cambiado."
      );
    }

    console.log(
      `\nEncontrados ${encontrados.length}/${objetivos.length} productos.`
    );

    const completos = await completarSKUs(encontrados);
    const faltantes = await guardarProductos(completos, objetivos);

    console.log("\n----------------------------------------");
    console.log("RESULTADO");
    console.log("----------------------------------------");
    console.table(
      completos.map((p) => ({
        Producto: p.nombre,
        Precio: p.precio,
        SKU: p.sku || "N/D",
      }))
    );

    if (faltantes.length) {
      console.log("\n⚠ Productos no encontrados:");
      faltantes.forEach((nombre) => console.log(`- ${nombre}`));
    }

    console.log("\n✓ Guardado en data/products.json");
  } catch (error) {
    console.error("\n❌ Error durante el scraping:");
    console.error(error.message);

    if (error.response) {
      console.error(`HTTP status: ${error.response.status}`);
    }

    process.exitCode = 1;
  }
}

main();
