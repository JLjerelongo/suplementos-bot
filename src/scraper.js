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

  // WooCommerce puede mostrar precio regular + rebajado.
  // Tomamos el último valor numérico mostrado.
  const ultimo = matches[matches.length - 1];

  const limpio = ultimo
    .replace(/\$/g, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const numero = Number(limpio);

  // Un precio 0 no es válido para este bot: suele indicar que el HTML
  // cambió o que el producto es variable/sin precio en el listado.
  return Number.isFinite(numero) && numero > 0 ? numero : null;
}

function productoCoincide(nombreWeb, objetivo) {
  const web = normalizarTexto(nombreWeb);

  const nombresValidos = [
    objetivo.name,
    ...(objetivo.aliases || []),
  ].map(normalizarTexto);

  return nombresValidos.includes(web);
}

function extraerPrecioDeProducto($) {
  // 1) Precio visible de la ficha WooCommerce.
  const selectores = [
    ".summary .price",
    ".product .summary .price",
    ".woocommerce-variation-price .price",
    ".price",
  ];

  for (const selector of selectores) {
    const texto = $(selector).first().text().trim();
    const precio = normalizarPrecio(texto);
    if (precio !== null) return precio;
  }

  // 2) Meta estándar de WooCommerce.
  const metaPrice = $('meta[itemprop="price"]').attr("content");
  const precioMeta = normalizarPrecio(metaPrice);
  if (precioMeta !== null) return precioMeta;

  // 3) JSON-LD: WooCommerce suele publicar offers.price.
  let precioJsonLd = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (precioJsonLd !== null) return;

    try {
      const raw = $(el).contents().text();
      const data = JSON.parse(raw);

      const recorrer = (valor) => {
        if (!valor || precioJsonLd !== null) return;

        if (Array.isArray(valor)) {
          valor.forEach(recorrer);
          return;
        }

        if (typeof valor !== "object") return;

        if (valor.offers) {
          const offers = Array.isArray(valor.offers)
            ? valor.offers
            : [valor.offers];

          for (const offer of offers) {
            const precio = normalizarPrecio(String(offer?.price ?? ""));
            if (precio !== null) {
              precioJsonLd = precio;
              return;
            }
          }
        }

        Object.values(valor).forEach(recorrer);
      };

      recorrer(data);
    } catch {
      // Ignoramos JSON-LD inválido y seguimos con otros métodos.
    }
  });

  return precioJsonLd;
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

    if (!nombre || !url) return;

    const precioTexto = item.find(".price").first().text().trim();
    const precio = normalizarPrecio(precioTexto);

    // Guardamos el producto aunque el precio del listado no pueda leerse.
    // Luego intentamos obtenerlo desde la ficha individual.
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
  const config = JSON.parse(raw.replace(/^\uFEFF/, ""));

  if (!Array.isArray(config.products) || config.products.length === 0) {
    throw new Error("data/monitored-products.json no contiene productos.");
  }

  return config.products;
}

async function extraerProductosDePagina(url) {
  const response = await http.get(url);
  return {
    html: response.data,
    productos: extraerProductosDeListado(response.data),
  };
}

async function obtenerPrecioDeFicha(url) {
  try {
    const response = await http.get(url);
    const $ = cheerio.load(response.data);

    const precio = extraerPrecioDeProducto($);
    return precio;
  } catch {
    return null;
  }
}

async function resolverProducto(candidato, objetivo) {
  let precio = candidato.precio;

  if (precio === null) {
    console.log(`  ↳ Precio no legible en listado. Consultando ficha: ${candidato.url}`);
    precio = await obtenerPrecioDeFicha(candidato.url);
  }

  if (precio === null) {
    throw new Error(
      `No se pudo obtener un precio válido para "${objetivo.name}" desde el listado ni desde su ficha.`
    );
  }

  return {
    objetivo: objetivo.name,
    brand: objetivo.brand,
    nombre: candidato.nombre,
    precio,
    url: candidato.url,
    sku: null,
  };
}

async function encontrarProductosMonitoreados(objetivos) {
  const encontrados = [];
  const encontradosKeys = new Set();

  const grupos = new Map();

  for (const objetivo of objetivos) {
    const origen = objetivo.categoryUrl || SHOP_URL;

    if (!grupos.has(origen)) grupos.set(origen, []);
    grupos.get(origen).push(objetivo);
  }

  // Primero buscamos en categorías/listados, como hasta ahora.
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

      const { html, productos } = await extraerProductosDePagina(url);

      for (const [nombreObjetivo, objetivo] of objetivosPendientes) {
        const candidato = productos.find((producto) =>
          productoCoincide(producto.nombre, objetivo)
        );

        if (!candidato) continue;

        const key = `${objetivo.name}|${candidato.url}`;

        if (!encontradosKeys.has(key)) {
          encontradosKeys.add(key);
          encontrados.push(await resolverProducto(candidato, objetivo));
        }

        objetivosPendientes.delete(nombreObjetivo);
      }

      if (objetivosPendientes.size === 0) break;

      const siguiente = detectarSiguientePagina(html, pagina);

      if (!siguiente || siguiente === url) break;

      url = siguiente;
      pagina += 1;

      await dormir(700);
    }
  }

  // Respaldo: si un producto tiene productUrl, lo consultamos directamente.
  // Esto cubre productos que dejaron de aparecer en una categoría/listado.
  for (const objetivo of objetivos) {
    const yaEncontrado = encontrados.some(
      (producto) => producto.objetivo === objetivo.name
    );

    if (yaEncontrado || !objetivo.productUrl) continue;

    console.log(`→ Respaldo por ficha directa: ${objetivo.productUrl}`);

    try {
      const response = await http.get(objetivo.productUrl);
      const $ = cheerio.load(response.data);

      const nombre =
        $(".product_title").first().text().trim() ||
        $(".entry-title").first().text().trim() ||
        objetivo.name;

      const precio = extraerPrecioDeProducto($);

      if (precio === null) {
        throw new Error("precio no encontrado");
      }

      const key = `${objetivo.name}|${objetivo.productUrl}`;

      if (!encontradosKeys.has(key)) {
        encontradosKeys.add(key);
        encontrados.push({
          objetivo: objetivo.name,
          brand: objetivo.brand,
          nombre,
          precio,
          url: objetivo.productUrl,
          sku: null,
        });
      }
    } catch (error) {
      console.log(
        `  ⚠ No se pudo resolver ${objetivo.name} por ficha directa: ${error.message}`
      );
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
