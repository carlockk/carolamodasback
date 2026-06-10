require('dotenv').config();
const mongoose = require('mongoose');
const Local = require('../models/local.model');
const ProductoBase = require('../models/productBase.model');
const ProductoLocal = require('../models/productLocal.model');

const normalizarNombre = (value = '') =>
  String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const tieneImagen = (base) => Boolean(String(base?.imagen_url || '').trim());

const getArg = (name, fallback = '') => {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : fallback;
};

const main = async () => {
  const apply = process.argv.includes('--apply');
  const overwrite = process.argv.includes('--overwrite');
  const sourceName = getArg('source', 'coffee waffles san roman');
  const targetName = getArg('target', "coffee waffles o'higgins");

  if (!process.env.MONGO_URI) {
    throw new Error('Falta MONGO_URI en .env');
  }

  await mongoose.connect(process.env.MONGO_URI, { dbName: 'posaildb' });

  if (process.argv.includes('--list-locales')) {
    const allLocales = await Local.find({}, 'nombre direccion').sort({ nombre: 1 }).lean();
    console.log('Locales disponibles:');
    allLocales.forEach((local) => {
      console.log(`- ${local._id} | ${local.nombre}${local.direccion ? ` | ${local.direccion}` : ''}`);
    });
    return;
  }

  const locales = await Local.find({}).lean();

  const sourceLocal = locales.find((local) => normalizarNombre(local.nombre).includes(normalizarNombre(sourceName)));
  const targetLocal = locales.find((local) => normalizarNombre(local.nombre).includes(normalizarNombre(targetName)));

  if (!sourceLocal || !targetLocal) {
    console.log('Locales encontrados:');
    locales.forEach((local) => console.log(`- ${local.nombre} (${local._id})`));
    throw new Error('No se encontraron ambos locales. Revisa --source y --target.');
  }

  const [sourceProducts, targetProducts] = await Promise.all([
    ProductoLocal.find({ local: sourceLocal._id }).populate('productoBase').lean(),
    ProductoLocal.find({ local: targetLocal._id }).populate('productoBase').lean()
  ]);

  const sourceByName = new Map();
  sourceProducts.forEach((producto) => {
    const base = producto.productoBase;
    if (!base?.nombre || !tieneImagen(base)) return;
    const key = normalizarNombre(base.nombre);
    if (!sourceByName.has(key)) {
      sourceByName.set(key, producto);
    }
  });

  const cambios = [];
  const sinMatch = [];
  const yaConImagen = [];

  targetProducts.forEach((targetProduct) => {
    const targetBase = targetProduct.productoBase;
    if (!targetBase?.nombre) return;
    if (tieneImagen(targetBase) && !overwrite) {
      yaConImagen.push(targetBase.nombre);
      return;
    }

    const sourceProduct = sourceByName.get(normalizarNombre(targetBase.nombre));
    if (!sourceProduct?.productoBase?.imagen_url) {
      sinMatch.push(targetBase.nombre);
      return;
    }

    const imagenDestino = String(targetBase.imagen_url || '').trim();
    const imagenOrigen = String(sourceProduct.productoBase.imagen_url || '').trim();
    if (overwrite && imagenDestino === imagenOrigen) {
      yaConImagen.push(targetBase.nombre);
      return;
    }

    cambios.push({
      targetBaseId: targetBase._id,
      nombre: targetBase.nombre,
      imagen_url: imagenOrigen,
      cloudinary_id: sourceProduct.productoBase.cloudinary_id || '',
      sourceBaseId: sourceProduct.productoBase._id,
      imagen_actual: imagenDestino
    });
  });

  console.log(`Origen: ${sourceLocal.nombre} (${sourceLocal._id})`);
  console.log(`Destino: ${targetLocal.nombre} (${targetLocal._id})`);
  console.log(`Productos origen con imagen: ${sourceByName.size}`);
  console.log(`Productos destino: ${targetProducts.length}`);
  console.log(`Destino ya con imagen: ${yaConImagen.length}`);
  console.log(`Cambios detectados: ${cambios.length}`);
  console.log(`Sin match con imagen en origen: ${sinMatch.length}`);

  if (cambios.length > 0) {
    console.log('\nCambios:');
    cambios.forEach((cambio) => {
      console.log(`- ${cambio.nombre}`);
      if (cambio.imagen_actual) console.log(`  actual: ${cambio.imagen_actual}`);
      console.log(`  nueva:  ${cambio.imagen_url}`);
    });
  }

  if (sinMatch.length > 0) {
    console.log('\nSin imagen para copiar:');
    sinMatch.forEach((nombre) => console.log(`- ${nombre}`));
  }

  if (!apply) {
    console.log('\nDry run. Ejecuta con --apply para aplicar cambios. Usa --overwrite para reemplazar tambien imagenes existentes distintas.');
    return;
  }

  for (const cambio of cambios) {
    await ProductoBase.updateOne(
      { _id: cambio.targetBaseId },
      {
        $set: {
          imagen_url: cambio.imagen_url,
          cloudinary_id: cambio.cloudinary_id
        }
      }
    );
  }

  console.log(`\nAplicado. Productos actualizados: ${cambios.length}`);
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
