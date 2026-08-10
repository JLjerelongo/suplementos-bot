const fs = require("fs");
const path = require("path");

const currentFile = path.join(process.cwd(), "data", "products.json");
const previousFile = path.join(
  process.cwd(),
  process.env.STORAGE_DIR || "storage",
  "previous-products.json"
);

if (!fs.existsSync(currentFile)) {
  console.error("No existe data/products.json.");
  console.error("Primero ejecutá: npm run check");
  process.exit(1);
}

const current = JSON.parse(fs.readFileSync(currentFile, "utf8"));

if (!Array.isArray(current.products) || current.products.length === 0) {
  console.error("data/products.json no contiene productos.");
  process.exit(1);
}

const target = current.products.find((p) =>
  String(p.nombre || "").toUpperCase().includes("CREATINA DOY PACK 300GR")
);

if (!target) {
  console.error("No encontré CREATINA DOY PACK 300GR.");
  process.exit(1);
}

const previous = {
  ...current,
  products: current.products.map((p) =>
    p.url === target.url
      ? { ...p, precio: Number(p.precio) + 1000 }
      : p
  ),
};

fs.mkdirSync(path.dirname(previousFile), { recursive: true });
fs.writeFileSync(previousFile, JSON.stringify(previous, null, 2), "utf8");

console.log("✓ Baseline de prueba preparado.");
console.log(`Producto: ${target.nombre}`);
console.log(`Precio real actual: $${target.precio}`);
console.log(`Precio simulado anterior: $${Number(target.precio) + 1000}`);
console.log("");
console.log("Ahora ejecutá:");
console.log("  npm run check");
console.log("");
console.log("El scraper volverá a obtener el precio real y el comparador");
console.log("detectará la diferencia contra este baseline artificial.");
