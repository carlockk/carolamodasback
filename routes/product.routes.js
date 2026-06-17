const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const ProductoBase = require('../models/productBase.model.js');
const ProductoLocal = require('../models/productLocal.model.js');
const Categoria = require('../models/categoria.model.js');
const Agregado = require('../models/agregado.model');
const { subirImagen, eliminarImagen } = require('../utils/cloudinary');
const { sanitizeText, sanitizeOptionalText } = require('../utils/input');
const { adjuntarScopeLocal, requiereLocal } = require('../middlewares/localScope');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() }); // Guarda la imagen temporalmente en memoria
router.use(adjuntarScopeLocal);
router.use(requiereLocal);

const isValidHttpUrl = (value) => {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const decodeHtmlEntities = (value = '') =>
  String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const extractImageFromLdJson = (html = '') => {
  const scripts = String(html).match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const content = script
      .replace(/^<script[^>]*>/i, '')
      .replace(/<\/script>$/i, '')
      .trim();
    if (!content) continue;
    try {
      const parsed = JSON.parse(content);
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;

        const image = item.image;
        if (typeof image === 'string' && isValidHttpUrl(image)) {
          return image;
        }
        if (Array.isArray(image)) {
          const firstString = image.find((entry) => typeof entry === 'string' && isValidHttpUrl(entry));
          if (firstString) return firstString;
          image.forEach((entry) => {
            if (entry && typeof entry === 'object') queue.push(entry);
          });
        } else if (image && typeof image === 'object') {
          if (typeof image.url === 'string' && isValidHttpUrl(image.url)) {
            return image.url;
          }
          queue.push(image);
        }

        Object.values(item).forEach((value) => {
          if (value && typeof value === 'object') queue.push(value);
        });
      }
    } catch {
      // Ignora bloques JSON-LD inválidos.
    }
  }
  return '';
};

const extractImageUrlFromHtml = (html = '') => {
  const source = String(html);
  const metaRegex = /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
  const metaRegexAlt = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']([^"']+)["'][^>]*>/gi;
  const acceptedKeys = new Set(['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);

  let match;
  while ((match = metaRegex.exec(source)) !== null) {
    const key = String(match[1] || '').toLowerCase().trim();
    const value = decodeHtmlEntities(match[2] || '').trim();
    if (acceptedKeys.has(key) && value) return value;
  }

  while ((match = metaRegexAlt.exec(source)) !== null) {
    const value = decodeHtmlEntities(match[1] || '').trim();
    const key = String(match[2] || '').toLowerCase().trim();
    if (acceptedKeys.has(key) && value) return value;
  }

  return extractImageFromLdJson(source);
};

const fetchImageBufferFromUrl = async (targetUrl) => {
  const response = await fetch(targetUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'image/*,text/html;q=0.9,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error('No se pudo descargar la imagen desde la URL');
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.startsWith('image/')) {
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimetype: contentType.split(';')[0] || 'image/jpeg'
    };
  }

  if (contentType.includes('text/html')) {
    const html = await response.text();
    const ogImageRaw = extractImageUrlFromHtml(html);
    if (!ogImageRaw) {
      throw new Error(
        'No se pudo extraer una imagen del enlace. Si es Instagram, usa una URL directa de imagen o sube el archivo.'
      );
    }
    const ogImageUrl = new URL(ogImageRaw, targetUrl).toString();
    if (!isValidHttpUrl(ogImageUrl)) {
      throw new Error('No se pudo obtener una imagen válida desde la URL');
    }

    const imageResponse = await fetch(ogImageUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'image/*,*/*;q=0.8'
      }
    });

    if (!imageResponse.ok) {
      throw new Error('No se pudo descargar la imagen del enlace compartido');
    }
    const ogContentType = String(imageResponse.headers.get('content-type') || '').toLowerCase();
    if (!ogContentType.startsWith('image/')) {
      throw new Error('El enlace compartido no apunta a una imagen');
    }
    const ogArrayBuffer = await imageResponse.arrayBuffer();
    return {
      buffer: Buffer.from(ogArrayBuffer),
      mimetype: ogContentType.split(';')[0] || 'image/jpeg'
    };
  }

  throw new Error('La URL no corresponde a una imagen');
};

const normalizeCategoriaId = (raw) => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
    return trimmed;
  }
  return raw;
};

const validarCategoriaProducto = async ({ localId, categoriaId }) => {
  if (!categoriaId) return null;
  if (!mongoose.Types.ObjectId.isValid(categoriaId)) {
    throw new Error('La categoria es invalida');
  }

  const categoria = await Categoria.findOne({ _id: categoriaId, local: localId }, '_id').lean();
  if (!categoria) {
    throw new Error('La categoria es invalida');
  }

  const tieneSubcategorias = await Categoria.exists({ parent: categoriaId, local: localId });
  if (tieneSubcategorias) {
    throw new Error('No se puede asignar productos a una categoria padre con subcategorias');
  }

  return categoria;
};

const resolverCategoriaEnLocalPorNombre = async ({ sourceCategoriaId, targetLocalId }) => {
  if (!sourceCategoriaId || !mongoose.Types.ObjectId.isValid(sourceCategoriaId)) return null;

  const origen = await Categoria.findById(sourceCategoriaId, 'nombre').lean();
  if (!origen?.nombre) return null;

  const destino = await Categoria.findOne(
    { local: targetLocalId, nombre: origen.nombre },
    '_id'
  ).lean();

  return destino ? destino._id : null;
};

const resolverAgregadosEnLocalPorNombre = async ({ sourceAgregadoIds = [], targetLocalId }) => {
  const ids = Array.isArray(sourceAgregadoIds)
    ? sourceAgregadoIds.filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
    : [];
  if (ids.length === 0) return [];

  const origen = await Agregado.find({ _id: { $in: ids } }, 'nombre').lean();
  const nombres = origen
    .map((a) => sanitizeText(a?.nombre, { max: 120 }))
    .filter(Boolean);
  if (nombres.length === 0) return [];

  const destino = await Agregado.find(
    { local: targetLocalId, nombre: { $in: nombres } },
    '_id nombre'
  ).lean();

  const setNombres = new Set(nombres.map((n) => n.toLowerCase()));
  return destino
    .filter((a) => setNombres.has(String(a.nombre || '').trim().toLowerCase()))
    .map((a) => a._id);
};

const parseStockValue = (valor, controlarStock = true) => {
  if (!controlarStock) return null;
  if (valor === undefined || valor === null || valor === '') return null;
  const numero = Number(valor);
  if (Number.isNaN(numero)) {
    throw new Error('El stock debe ser numérico');
  }
  if (numero < 0) {
    throw new Error('El stock no puede ser negativo');
  }
  return numero;
};

const normalizarVariantes = (raw) => {
  if (raw === undefined || raw === null || raw === '' || raw === '[]') {
    return [];
  }

  let parsed = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      throw new Error('Formato de variantes inválido');
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Las variantes deben ser un arreglo');
  }

  return parsed
    .map((variant) => {
      if (!variant || typeof variant !== 'object') return null;

      const nombre = sanitizeText(variant.nombre, { max: 80 });
      if (!nombre) {
        throw new Error('Cada variante debe tener un nombre');
      }

      const precio =
        variant.precio === '' || variant.precio === null || variant.precio === undefined
          ? undefined
          : Number(variant.precio);
      if (precio !== undefined && Number.isNaN(precio)) {
        throw new Error(`El precio de la variante "${nombre}" es inválido`);
      }

      const stockRaw =
        variant.stock === '' || variant.stock === null || variant.stock === undefined
          ? null
          : Number(variant.stock);
      if (stockRaw !== null && (Number.isNaN(stockRaw) || stockRaw < 0)) {
        throw new Error(`El stock de la variante "${nombre}" es inválido`);
      }
      const stock = stockRaw !== null ? stockRaw : null;
      const agotado = variant.agotado === true || String(variant.agotado) === 'true';

      return {
        _id: variant._id && String(variant._id).length ? variant._id : undefined,
        baseVarianteId:
          variant.baseVarianteId && String(variant.baseVarianteId).length
            ? String(variant.baseVarianteId)
            : undefined,
        nombre,
        color: sanitizeOptionalText(variant.color, { max: 40 }) || undefined,
        talla: sanitizeOptionalText(variant.talla, { max: 40 }) || undefined,
        precio: precio !== undefined ? precio : undefined,
        stock,
        agotado,
        sku: sanitizeOptionalText(variant.sku, { max: 40 }) || undefined
      };
    })
    .filter(Boolean);
};

const parseObjectIdArray = (raw) => {
  let parsed = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return Array.from(
    new Set(
      parsed
        .map((id) => String(id || '').trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    )
  );
};

const calcularStockTotal = (variantes, stockBase) => {
  if (Array.isArray(variantes) && variantes.length > 0) {
    const stocks = variantes
      .map((vari) => {
        if (vari?.stock === null || vari?.stock === undefined || vari?.stock === '') return null;
        return Number(vari.stock);
      })
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (stocks.length === 0) return null;
    return stocks.reduce((acc, val) => acc + val, 0);
  }
  return stockBase;
};

const optimizarImagenCatalogo = (url) => {
  const value = String(url || '');
  if (!value.includes('res.cloudinary.com') || !value.includes('/upload/')) return value;
  if (value.includes('/upload/f_auto,q_auto')) return value;
  return value.replace('/upload/', '/upload/f_auto,q_auto:good,w_600,c_limit/');
};

const proyectarProductoLocal = (productoLocal, agregadosOverride = null) => {
  const base = productoLocal?.productoBase || {};
  const sourceAgregados = Array.isArray(agregadosOverride)
    ? agregadosOverride
    : productoLocal.agregados;
  return {
    _id: productoLocal._id,
    local: productoLocal.local,
    activo: productoLocal.activo,
    precio: productoLocal.precio,
    stock: productoLocal.stock,
    stock_total: productoLocal.stock_total,
    agregados: Array.isArray(sourceAgregados)
      ? sourceAgregados.map((agg) => {
          if (agg && typeof agg === 'object' && agg._id) {
            return {
              _id: agg._id,
              nombre: agg.nombre,
              precio: typeof agg.precio === 'number' ? agg.precio : null,
              activo: agg.activo !== false,
              grupo: agg.grupo || null,
              grupos: Array.isArray(agg.grupos) ? agg.grupos : []
            };
          }
          return agg;
        })
      : [],
    variantes: productoLocal.variantes || [],
    creado_en: productoLocal.creado_en,
    productoBaseId: base._id || null,
    nombre: base.nombre || '',
    descripcion: base.descripcion || '',
    imagen_url: optimizarImagenCatalogo(base.imagen_url),
    cloudinary_id: base.cloudinary_id || '',
    categoria: base.categoria || null
  };
};

const getObjectIdString = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return String(value._id);
  return '';
};

const combinarAgregadosPorReglas = async (localId, productosLocales = []) => {
  const resultado = new Map();
  if (!Array.isArray(productosLocales) || productosLocales.length === 0) return resultado;

  const productoIds = productosLocales.map((p) => String(p._id));
  const categoriaIds = Array.from(
    new Set(
      productosLocales
        .map((p) => getObjectIdString(p?.productoBase?.categoria))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    )
  );

  const autoAgregados = await Agregado.find({
    local: localId,
    activo: true,
    $or: [
      { productos: { $in: productoIds } },
      { categorias: { $in: categoriaIds } }
    ]
  })
    .select('nombre precio activo grupo grupos productos categorias')
    .populate([
      { path: 'grupo', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' },
      { path: 'grupos', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' }
    ])
    .lean();

  const porProductoId = new Map();

  autoAgregados.forEach((agg) => {
    const aggId = String(agg._id);
    const productosSet = new Set((agg.productos || []).map((id) => String(id)));
    const categoriasSet = new Set((agg.categorias || []).map((id) => String(id)));

    productosLocales.forEach((prod) => {
      const prodId = String(prod._id);
      const prodCategoriaId = getObjectIdString(prod?.productoBase?.categoria);
      const aplicaPorProducto = productosSet.has(prodId);
      const aplicaPorCategoria = prodCategoriaId && categoriasSet.has(prodCategoriaId);

      if (!aplicaPorProducto && !aplicaPorCategoria) return;

      if (!porProductoId.has(prodId)) porProductoId.set(prodId, new Map());
      porProductoId.get(prodId).set(aggId, agg);
    });
  });

  productosLocales.forEach((prod) => {
    const prodId = String(prod._id);
    const manuales = Array.isArray(prod.agregados) ? prod.agregados : [];
    const autoMap = porProductoId.get(prodId) || new Map();
    const merged = new Map();

    manuales.forEach((agg) => {
      const aggId = getObjectIdString(agg);
      if (aggId) merged.set(aggId, agg);
    });
    autoMap.forEach((agg, aggId) => {
      if (!merged.has(aggId)) merged.set(aggId, agg);
    });

    resultado.set(prodId, Array.from(merged.values()));
  });

  return resultado;
};

router.get('/base', async (req, res) => {
  try {
    const bases = await ProductoBase.find().sort({ creado_en: -1 });
    res.json(bases);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener catalogo base' });
  }
});

router.post('/base', upload.single('imagen'), async (req, res) => {
  try {
    let imagen_url = '';
    let cloudinary_id = '';

    if (req.file) {
      const subida = await subirImagen(req.file);
      imagen_url = subida.secure_url;
      cloudinary_id = subida.public_id;
    }

    const nombre = sanitizeText(req.body.nombre, { max: 120 });
    if (!nombre) throw new Error('El nombre del producto es requerido');

    const descripcion = sanitizeOptionalText(req.body.descripcion, { max: 300 }) || '';
    const variantes = normalizarVariantes(req.body.variantes).map((v) => ({
      nombre: v.nombre,
      color: v.color,
      talla: v.talla,
      sku: v.sku
    }));

    const categoriaId = normalizeCategoriaId(req.body.categoria);
    if (categoriaId) {
      await validarCategoriaProducto({ localId: req.localId, categoriaId });
    }

    const base = new ProductoBase({
      nombre,
      descripcion,
      imagen_url,
      cloudinary_id,
      categoria: categoriaId || null,
      variantes
    });

    const guardado = await base.save();
    res.status(201).json(guardado);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Error al crear producto base' });
  }
});

router.post('/local/use-base/:baseId', async (req, res) => {
  try {
    const { baseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(baseId)) {
      return res.status(400).json({ error: 'Producto base invalido' });
    }

    const base = await ProductoBase.findById(baseId);
    if (!base) return res.status(404).json({ error: 'Producto base no encontrado' });

    const existentesLocal = await ProductoLocal.find({ local: req.localId })
      .populate('productoBase', 'nombre')
      .lean();
    const nombreBase = String(base.nombre || '').trim().toLowerCase();
    const existe = existentesLocal.some(
      (item) => String(item?.productoBase?.nombre || '').trim().toLowerCase() === nombreBase
    );
    if (existe) {
      return res.status(400).json({ error: 'Ese producto ya existe en este local' });
    }

    const precio = Number(req.body?.precio);
    if (Number.isNaN(precio)) {
      return res.status(400).json({ error: 'El precio es invalido' });
    }

    const controlarStock = String(req.body?.controlarStock) === 'true';
    const stockBase = parseStockValue(req.body?.stock, controlarStock);
    const categoriaMapeada = await resolverCategoriaEnLocalPorNombre({
      sourceCategoriaId: base.categoria,
      targetLocalId: req.localId
    });

    const baseLocal = new ProductoBase({
      sku: base.sku || '',
      nombre: base.nombre,
      descripcion: base.descripcion || '',
      imagen_url: base.imagen_url || '',
      cloudinary_id: base.cloudinary_id || '',
      categoria: categoriaMapeada || null,
      variantes: Array.isArray(base.variantes)
        ? base.variantes.map((v) => ({
            nombre: v.nombre,
            color: v.color,
            talla: v.talla,
            sku: v.sku
          }))
        : []
    });
    const baseGuardado = await baseLocal.save();

    const variantesLocal = normalizarVariantes(req.body?.variantes).map((v, idx) => ({
      baseVarianteId: baseGuardado.variantes[idx]?._id || v._id,
      nombre: v.nombre,
      color: v.color,
      talla: v.talla,
      precio: v.precio,
      stock: v.stock,
      agotado: v.agotado,
      sku: v.sku
    }));
    const stockCalculado = calcularStockTotal(variantesLocal, stockBase);

    const local = new ProductoLocal({
      productoBase: baseGuardado._id,
      local: req.localId,
      precio,
      stock: stockCalculado,
      variantes: variantesLocal
    });

    const sourceProductoLocalId = String(req.body?.sourceProductoLocalId || '').trim();
    if (mongoose.Types.ObjectId.isValid(sourceProductoLocalId)) {
      const sourceProductoLocal = await ProductoLocal.findById(sourceProductoLocalId, 'agregados').lean();
      if (sourceProductoLocal?.agregados?.length) {
        const agregadosDestino = await resolverAgregadosEnLocalPorNombre({
          sourceAgregadoIds: sourceProductoLocal.agregados,
          targetLocalId: req.localId
        });
        if (agregadosDestino.length > 0) {
          local.agregados = agregadosDestino;
        }
      }
    }

    const guardado = await local.save();
    const poblado = await guardado.populate('productoBase');
    res.status(201).json(proyectarProductoLocal(poblado));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Error al crear producto local' });
  }
});

router.get('/', async (_req, res) => {
  try {
    const locales = await ProductoLocal.find({ local: _req.localId })
      .populate({
        path: 'productoBase',
        populate: { path: 'categoria', select: 'nombre parent', match: { local: _req.localId } }
      })
      .populate({
        path: 'agregados',
        select: 'nombre precio activo grupo grupos',
        populate: [
          { path: 'grupo', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' },
          { path: 'grupos', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' }
        ]
      })
      .sort({ creado_en: -1 });

    const agregadosPorProducto = await combinarAgregadosPorReglas(_req.localId, locales);

    return res.json(
      locales.map((prod) =>
        proyectarProductoLocal(prod, agregadosPorProducto.get(String(prod._id)) || null)
      )
    );
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const productoLocal = await ProductoLocal.findOne({
      _id: req.params.id,
      local: req.localId
    }).populate({
      path: 'productoBase',
      populate: { path: 'categoria', select: 'nombre parent', match: { local: req.localId } }
    }).populate({
      path: 'agregados',
      select: 'nombre precio activo grupo grupos',
      populate: [
        { path: 'grupo', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' },
        { path: 'grupos', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' }
      ]
    });
    if (productoLocal) {
      const agregadosPorProducto = await combinarAgregadosPorReglas(req.localId, [productoLocal]);
      return res.json(
        proyectarProductoLocal(
          productoLocal,
          agregadosPorProducto.get(String(productoLocal._id)) || null
        )
      );
    }
    return res.status(404).json({ error: 'Producto no encontrado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

router.post('/', upload.single('imagen'), async (req, res) => {
  try {
    let imagen_url = '';
    let cloudinary_id = '';
    const imagenUrlBody = sanitizeOptionalText(req.body.imagen_url, { max: 600 }) || '';

    if (req.file) {
      const subida = await subirImagen(req.file);
      imagen_url = subida.secure_url;
      cloudinary_id = subida.public_id;
    } else if (req.body.imagen_url !== undefined) {
      if (imagenUrlBody && !isValidHttpUrl(imagenUrlBody)) {
        throw new Error('La URL de imagen es invalida');
      }
      if (imagenUrlBody) {
        const remoteFile = await fetchImageBufferFromUrl(imagenUrlBody);
        const subida = await subirImagen(remoteFile);
        imagen_url = subida.secure_url;
        cloudinary_id = subida.public_id;
      } else {
        imagen_url = '';
      }
    }

    const nombre = sanitizeText(req.body.nombre, { max: 120 });
    if (!nombre) {
      throw new Error('El nombre del producto es requerido');
    }

    const descripcion = sanitizeOptionalText(req.body.descripcion, { max: 300 }) || '';

    const precio = Number(req.body.precio);
    if (Number.isNaN(precio)) {
      throw new Error('El precio es inválido');
    }

    const controlarStock = String(req.body.controlarStock) === 'true';
    const stockBase = parseStockValue(req.body.stock, controlarStock);
    const variantesRaw = normalizarVariantes(req.body.variantes);
    const agregadosRaw = parseObjectIdArray(req.body.agregados);
    const stockCalculado = calcularStockTotal(variantesRaw, stockBase);

    const categoriaId = normalizeCategoriaId(req.body.categoria);
    if (categoriaId) {
      await validarCategoriaProducto({ localId: req.localId, categoriaId });
    }

    let agregadosValidos = [];
    if (agregadosRaw.length > 0) {
      agregadosValidos = await Agregado.find(
        { local: req.localId, activo: true, _id: { $in: agregadosRaw } },
        '_id'
      ).lean();
    } else if (categoriaId) {
      agregadosValidos = await Agregado.find(
        { local: req.localId, activo: true, categorias: categoriaId },
        '_id'
      ).lean();
    }

    const base = new ProductoBase({
      nombre,
      descripcion,
      imagen_url,
      cloudinary_id,
      categoria: categoriaId || null,
      variantes: variantesRaw.map((v) => ({
        nombre: v.nombre,
        color: v.color,
        talla: v.talla,
        sku: v.sku
      }))
    });

    const baseGuardado = await base.save();

    const variantesLocales = variantesRaw.map((v, idx) => ({
      baseVarianteId: baseGuardado.variantes[idx]?._id,
      nombre: v.nombre,
      color: v.color,
      talla: v.talla,
      precio: v.precio,
      stock: v.stock,
      agotado: v.agotado,
      sku: v.sku
    }));

    const local = new ProductoLocal({
      productoBase: baseGuardado._id,
      local: req.localId,
      precio,
      stock: stockCalculado,
      agregados: agregadosValidos.map((a) => a._id),
      variantes: variantesLocales
    });

    const localGuardado = await local.save();
    const poblado = await localGuardado.populate([
      {
        path: 'productoBase',
        populate: { path: 'categoria', select: 'nombre parent' }
      },
      {
        path: 'agregados',
        select: 'nombre precio activo grupo grupos',
        populate: [
          { path: 'grupo', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' },
          { path: 'grupos', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' }
        ]
      }
    ]);

    res.status(201).json(proyectarProductoLocal(poblado));
  } catch (err) {
    console.error('❌ Error al crear producto:', err);
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', upload.single('imagen'), async (req, res) => {
  try {
    const productoLocal = await ProductoLocal.findOne({
      _id: req.params.id,
      local: req.localId
    }).populate('productoBase');

    if (productoLocal) {
      if (!productoLocal.productoBase) {
        throw new Error('Producto base no encontrado para este local');
      }

      const usosBase = await ProductoLocal.countDocuments({
        productoBase: productoLocal.productoBase._id
      });
      const baseEraCompartida = usosBase > 1;

      let baseEditable = productoLocal.productoBase;
      if (baseEraCompartida) {
        baseEditable = new ProductoBase({
          sku: baseEditable.sku || '',
          nombre: baseEditable.nombre,
          descripcion: baseEditable.descripcion || '',
          imagen_url: baseEditable.imagen_url || '',
          cloudinary_id: baseEditable.cloudinary_id || '',
          categoria: baseEditable.categoria || null,
          variantes: Array.isArray(baseEditable.variantes)
            ? baseEditable.variantes.map((v) => ({
                _id: v._id,
                nombre: v.nombre,
                color: v.color,
                talla: v.talla,
                sku: v.sku
              }))
            : []
        });
        await baseEditable.save();
        productoLocal.productoBase = baseEditable._id;
      }

      let imagen_url = baseEditable?.imagen_url || '';
      let cloudinary_id = baseEditable?.cloudinary_id || '';
      const imagenUrlBody = sanitizeOptionalText(req.body.imagen_url, { max: 600 }) || '';

      if (req.file) {
        if (cloudinary_id && !baseEraCompartida) await eliminarImagen(cloudinary_id);
        const subida = await subirImagen(req.file);
        imagen_url = subida.secure_url;
        cloudinary_id = subida.public_id;
      } else if (req.body.imagen_url !== undefined) {
        if (imagenUrlBody && !isValidHttpUrl(imagenUrlBody)) {
          throw new Error('La URL de imagen es invalida');
        }
        if (!imagenUrlBody) {
          if (cloudinary_id) {
            if (!baseEraCompartida) {
              await eliminarImagen(cloudinary_id);
            }
            cloudinary_id = '';
          }
          imagen_url = '';
        } else {
          const remoteFile = await fetchImageBufferFromUrl(imagenUrlBody);
          const subida = await subirImagen(remoteFile);
          const cloudinaryAnterior = cloudinary_id;
          imagen_url = subida.secure_url;
          cloudinary_id = subida.public_id;
          if (cloudinaryAnterior && !baseEraCompartida) {
            await eliminarImagen(cloudinaryAnterior);
          }
        }
      }

      const nombre = sanitizeText(req.body.nombre, { max: 120 });
      if (!nombre) {
        throw new Error('El nombre del producto es requerido');
      }

      const descripcion = sanitizeOptionalText(req.body.descripcion, { max: 300 }) || '';

      const precio = Number(req.body.precio);
      if (Number.isNaN(precio)) {
        throw new Error('El precio es inválido');
      }

      const controlarStock = String(req.body.controlarStock) === 'true';
      const stockBase = parseStockValue(req.body.stock, controlarStock);
      const variantesRaw = normalizarVariantes(req.body.variantes);
      const agregadosRaw = parseObjectIdArray(req.body.agregados);
      const baseActuales = Array.isArray(baseEditable?.variantes)
        ? baseEditable.variantes
        : [];
      const basePorId = new Map(baseActuales.map((b) => [String(b._id), b]));

      const variantesBaseActualizadas = variantesRaw.map((v) => {
        const refId = v.baseVarianteId || v._id;
        const baseExistente = refId ? basePorId.get(String(refId)) : null;

        return {
          _id: baseExistente?._id || new mongoose.Types.ObjectId(),
          nombre: v.nombre,
          color: v.color,
          talla: v.talla,
          sku: v.sku
        };
      });

      const variantes = variantesRaw.map((v, idx) => ({
        baseVarianteId: variantesBaseActualizadas[idx]._id,
        nombre: v.nombre,
        color: v.color,
        talla: v.talla,
        precio: v.precio,
        stock: v.stock,
        agotado: v.agotado,
        sku: v.sku
      }));
      const stockCalculado = calcularStockTotal(variantes, stockBase);
      let categoriaId = normalizeCategoriaId(req.body.categoria);
      if (categoriaId && !mongoose.Types.ObjectId.isValid(categoriaId)) {
        categoriaId = null;
      }
      if (categoriaId) {
        await validarCategoriaProducto({ localId: req.localId, categoriaId });
      }

      let agregadosValidos = [];
      if (agregadosRaw.length > 0) {
        agregadosValidos = await Agregado.find(
          { local: req.localId, activo: true, _id: { $in: agregadosRaw } },
          '_id'
        ).lean();
      } else if (categoriaId) {
        agregadosValidos = await Agregado.find(
          { local: req.localId, activo: true, categorias: categoriaId },
          '_id'
        ).lean();
      }

      if (baseEditable) {
        baseEditable.nombre = nombre;
        baseEditable.descripcion = descripcion;
        baseEditable.categoria = categoriaId || null;
        baseEditable.imagen_url = imagen_url;
        baseEditable.cloudinary_id = cloudinary_id;
        baseEditable.variantes = variantesBaseActualizadas;
        await baseEditable.save();
      }

      productoLocal.precio = precio;
      productoLocal.stock = stockCalculado;
      productoLocal.agregados = agregadosValidos.map((a) => a._id);
      productoLocal.variantes = variantes;

      const actualizado = await productoLocal.save();
      const poblado = await actualizado.populate([
        {
          path: 'productoBase',
          populate: { path: 'categoria', select: 'nombre parent' }
        },
        {
          path: 'agregados',
          select: 'nombre precio activo grupo grupos',
          populate: [
            { path: 'grupo', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' },
            { path: 'grupos', select: 'categoriaPrincipal titulo modoSeleccion obligatorio' }
          ]
        }
      ]);
      return res.json(proyectarProductoLocal(poblado));
    }

    return res.status(404).json({ error: 'Producto no encontrado' });
  } catch (err) {
    console.error('❌ Error al editar producto:', err);
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (req.userRole === 'cajero') {
      return res.status(403).json({ error: 'No tienes permisos para eliminar productos' });
    }

    const productoLocal = await ProductoLocal.findOne({ _id: req.params.id, local: req.localId });
    if (productoLocal) {
      await productoLocal.deleteOne();
      return res.json({ mensaje: 'Producto eliminado correctamente' });
    }

    return res.status(404).json({ error: 'Producto no encontrado' });
  } catch (err) {
    console.error('Error al eliminar producto:', err);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
