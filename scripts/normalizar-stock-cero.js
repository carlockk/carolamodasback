require('dotenv').config();

const mongoose = require('mongoose');
const Local = require('../models/local.model');
const ProductoLocal = require('../models/productLocal.model');

const aplicarCambios = process.argv.includes('--apply');
const localArgIndex = process.argv.findIndex((arg) => arg === '--local');
const localFiltro =
  localArgIndex >= 0 && process.argv[localArgIndex + 1]
    ? String(process.argv[localArgIndex + 1]).trim()
    : '';

const recalcularStockLocal = (producto) => {
  if (!Array.isArray(producto.variantes) || producto.variantes.length === 0) {
    return producto.stock === 0 ? null : producto.stock;
  }

  const stocksControlados = producto.variantes
    .map((variante) => {
      if (variante.stock === null || variante.stock === undefined || variante.stock === '') return null;
      const numero = Number(variante.stock);
      return Number.isFinite(numero) && numero >= 0 ? numero : null;
    })
    .filter((stock) => stock !== null);

  if (stocksControlados.length === 0) return null;
  return stocksControlados.reduce((acc, stock) => acc + stock, 0);
};

const crearResumenVacio = (local) => ({
  localId: String(local._id),
  localNombre: local.nombre || 'Sin nombre',
  productos: 0,
  productosStockCero: 0,
  variantesStockCero: 0,
  productosActualizados: 0
});

const main = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('Falta MONGO_URI en .env');
  }

  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || 'posaildb'
  });

  const filtroLocales = {};
  if (localFiltro) {
    if (!mongoose.Types.ObjectId.isValid(localFiltro)) {
      throw new Error('--local debe ser un ObjectId valido');
    }
    filtroLocales._id = localFiltro;
  }

  const locales = await Local.find(filtroLocales).sort({ nombre: 1 }).lean();
  const resumenes = [];

  for (const local of locales) {
    const resumen = crearResumenVacio(local);
    const productos = await ProductoLocal.find({ local: local._id }).sort({ creado_en: 1 });
    resumen.productos = productos.length;

    for (const producto of productos) {
      let debeGuardar = false;

      if (producto.stock === 0) {
        resumen.productosStockCero += 1;
        if (aplicarCambios) {
          producto.stock = null;
          debeGuardar = true;
        }
      }

      if (Array.isArray(producto.variantes)) {
        for (const variante of producto.variantes) {
          if (variante.stock === 0) {
            resumen.variantesStockCero += 1;
            if (aplicarCambios) {
              variante.stock = null;
              debeGuardar = true;
            }
          }
        }
      }

      if (aplicarCambios && debeGuardar) {
        producto.stock = recalcularStockLocal(producto);
        await producto.save();
        resumen.productosActualizados += 1;
      }
    }

    resumenes.push(resumen);
  }

  const modo = aplicarCambios ? 'APLICADO' : 'DRY RUN';
  console.log(`Normalizacion stock cero (${modo})`);
  console.table(resumenes);
  console.log(
    aplicarCambios
      ? 'Listo: los stock 0 encontrados quedaron en null.'
      : 'No se modifico la base. Ejecuta con --apply para cambiar stock 0 a null.'
  );
};

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
