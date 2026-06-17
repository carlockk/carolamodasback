const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const Insumo = require('../models/insumo.model');
const InsumoLote = require('../models/insumoLote.model');
const InsumoMovimiento = require('../models/insumoMovimiento.model');
const InsumoAlertaConfig = require('../models/insumoAlertaConfig.model');
const ProductoLocal = require('../models/productLocal.model');
const Usuario = require('../models/usuario.model.js');
const Local = require('../models/local.model');
const { subirImagen } = require('../utils/cloudinary');
const { sanitizeText, sanitizeOptionalText, toNumberOrNull } = require('../utils/input');
const { sendMail } = require('../utils/mailer');
const { adjuntarScopeLocal, requiereLocal } = require('../middlewares/localScope');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
router.use(adjuntarScopeLocal);
router.use(requiereLocal);

const parsePositiveNumber = (value, field) => {
  const numero = Number(value);
  if (!Number.isFinite(numero) || numero < 0) {
    throw new Error(`El campo ${field} es invalido`);
  }
  return numero;
};

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildExactMatch = (value) => ({
  $regex: `^${escapeRegex(String(value || ''))}$`,
  $options: 'i'
});

const normalizarTexto = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const calcularStockDesdeVariantes = (variantes = []) => {
  const stocks = variantes
    .map((vari) => {
      if (vari?.stock === null || vari?.stock === undefined || vari?.stock === '') return null;
      const valor = Number(vari.stock);
      return Number.isFinite(valor) && valor >= 0 ? valor : null;
    })
    .filter((valor) => valor !== null);

  if (stocks.length === 0) return null;
  return stocks.reduce((acc, stock) => acc + stock, 0);
};

const isValidHttpUrl = (value) => {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const rolesObservaciones = new Set(['admin', 'superadmin', 'cajero']);

const puedeGestionarObservaciones = (userRole) => rolesObservaciones.has(String(userRole || '').toLowerCase());

const sameDay = (a, b) => {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
};

const obtenerDestinatarios = async (localId) => {
  const config = await InsumoAlertaConfig.findOne({ local: localId });
  if (!config || !Array.isArray(config.usuarios) || config.usuarios.length === 0) {
    return [];
  }
  const usuarios = await Usuario.find({ _id: { $in: config.usuarios } }, 'email nombre');
  return usuarios
    .map((u) => ({ email: u.email, nombre: u.nombre }))
    .filter((u) => Boolean(u.email));
};

const construirFiltroDuplicadoInsumo = ({ nombre, sku, color, talla, localId, excludeId = null }) => {
  const filtro = {
    local: localId,
    nombre: buildExactMatch(nombre),
    sku: buildExactMatch(sku || ''),
    color: buildExactMatch(color || ''),
    talla: buildExactMatch(talla || '')
  };

  if (excludeId) {
    filtro._id = { $ne: excludeId };
  }

  return filtro;
};

const resolverRelacionProducto = async ({ productoIdRaw, varianteIdRaw, localId, session }) => {
  const productoId = String(productoIdRaw || '').trim();
  const varianteId = String(varianteIdRaw || '').trim();

  if (!productoId) {
    return { producto: null, productoId: null, varianteId: null };
  }

  if (!mongoose.Types.ObjectId.isValid(productoId)) {
    throw new Error('Producto relacionado invalido');
  }

  const producto = await ProductoLocal.findOne({ _id: productoId, local: localId })
    .populate('productoBase', 'nombre sku descripcion imagen_url')
    .session(session || null);

  if (!producto) {
    throw new Error('Producto relacionado no encontrado');
  }

  const variantes = Array.isArray(producto.variantes) ? producto.variantes : [];
  if (variantes.length === 0) {
    return { producto, productoId: producto._id, varianteId: null };
  }

  if (!varianteId) {
    throw new Error('Debes seleccionar una variante relacionada');
  }

  const variante = variantes.find((item) => String(item?._id) === varianteId);
  if (!variante) {
    throw new Error('Variante relacionada invalida');
  }

  return { producto, productoId: producto._id, varianteId: variante._id };
};

const sincronizarSalidaBodegaConProducto = async ({ insumo, cantidad, localId, session }) => {
  const productoRelacionadoId = String(insumo?.producto_relacionado || '').trim();
  const varianteRelacionadaId = String(insumo?.variante_relacionada || '').trim();

  if (productoRelacionadoId && mongoose.Types.ObjectId.isValid(productoRelacionadoId)) {
    const productoRelacionado = await ProductoLocal.findOne({ _id: productoRelacionadoId, local: localId })
      .session(session);

    if (productoRelacionado) {
      const variantes = Array.isArray(productoRelacionado.variantes) ? productoRelacionado.variantes : [];
      const varianteRelacionada = varianteRelacionadaId
        ? variantes.find((item) => String(item?._id) === varianteRelacionadaId)
        : null;

      if (varianteRelacionada) {
        const stockActual = Number(varianteRelacionada.stock);
        varianteRelacionada.stock =
          Number.isFinite(stockActual) && stockActual >= 0 ? stockActual + cantidad : cantidad;
        productoRelacionado.stock = calcularStockDesdeVariantes(productoRelacionado.variantes);
        await productoRelacionado.save({ session });
        return {
          productoId: productoRelacionado._id,
          varianteId: varianteRelacionada._id
        };
      }

      if (variantes.length === 0) {
        const stockActual = Number(productoRelacionado.stock);
        productoRelacionado.stock =
          Number.isFinite(stockActual) && stockActual >= 0 ? stockActual + cantidad : cantidad;
        await productoRelacionado.save({ session });
        return {
          productoId: productoRelacionado._id,
          varianteId: null
        };
      }
    }
  }

  const nombre = normalizarTexto(insumo?.nombre);
  const sku = normalizarTexto(insumo?.sku);
  const color = normalizarTexto(insumo?.color);
  const talla = normalizarTexto(insumo?.talla);

  if (!nombre && !sku) return null;

  const productos = await ProductoLocal.find({ local: localId })
    .populate('productoBase', 'nombre sku')
    .session(session);

  let productoMatch = null;
  let varianteMatch = null;

  if (sku) {
    for (const producto of productos) {
      const baseSku = normalizarTexto(producto?.productoBase?.sku);
      if (baseSku && baseSku === sku) {
        productoMatch = producto;
        break;
      }

      const variante = Array.isArray(producto?.variantes)
        ? producto.variantes.find((item) => normalizarTexto(item?.sku) === sku)
        : null;
      if (variante) {
        productoMatch = producto;
        varianteMatch = variante;
        break;
      }
    }
  }

  if (!productoMatch) {
    for (const producto of productos) {
      const nombreProducto = normalizarTexto(producto?.productoBase?.nombre);
      if (!nombreProducto || nombreProducto !== nombre) continue;

      const variante = Array.isArray(producto?.variantes)
        ? producto.variantes.find((item) => {
            const colorVariante = normalizarTexto(item?.color);
            const tallaVariante = normalizarTexto(item?.talla);
            return colorVariante === color && tallaVariante === talla;
          })
        : null;

      if (variante) {
        productoMatch = producto;
        varianteMatch = variante;
        break;
      }

      if ((!color && !talla) || !Array.isArray(producto?.variantes) || producto.variantes.length === 0) {
        productoMatch = producto;
        break;
      }
    }
  }

  if (!productoMatch) return null;

  if (varianteMatch) {
    const stockActual = Number(varianteMatch.stock);
    varianteMatch.stock = Number.isFinite(stockActual) && stockActual >= 0 ? stockActual + cantidad : cantidad;
    productoMatch.stock = calcularStockDesdeVariantes(productoMatch.variantes);
  } else {
    const stockActual = Number(productoMatch.stock);
    productoMatch.stock = Number.isFinite(stockActual) && stockActual >= 0 ? stockActual + cantidad : cantidad;
  }

  await productoMatch.save({ session });

  return {
    productoId: productoMatch._id,
    varianteId: varianteMatch?._id || null
  };
};

router.get('/', async (req, res) => {
  try {
    const incluirOcultos = String(req.query?.incluir_ocultos) === 'true';
    const filtro = { local: req.localId };
    if (!incluirOcultos) {
      filtro.$or = [{ activo: true }, { activo: { $exists: false } }];
    }
    const insumos = await Insumo.find(filtro)
      .populate('categoria', 'nombre')
      .sort({ orden: 1, nombre: 1 });
    res.json(insumos);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener insumos' });
  }
});

router.put('/orden', async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.userRole)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const orden = Array.isArray(req.body?.orden) ? req.body.orden : [];
    const ids = Array.from(new Set(orden.filter((id) => mongoose.Types.ObjectId.isValid(id))));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'Orden invalido' });
    }
    await Promise.all(
      ids.map((id, index) =>
        Insumo.updateOne({ _id: id, local: req.localId }, { orden: index + 1 })
      )
    );
    res.json({ mensaje: 'Orden actualizado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar orden' });
  }
});

router.put('/:id/nota', async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.userRole)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const nota = sanitizeOptionalText(req.body.nota, { max: 500 }) || '';
    const insumo = await Insumo.findOneAndUpdate(
      { _id: req.params.id, local: req.localId },
      { ultima_nota: nota.trim() ? nota.trim() : null, actualizado_en: new Date() },
      { new: true }
    );
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });
    res.json(insumo);
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar nota' });
  }
});

router.get('/:id/observaciones', async (req, res) => {
  try {
    if (!puedeGestionarObservaciones(req.userRole)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId });
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });

    // Compatibilidad: si solo existe la nota legacy, la migra a la nueva lista.
    if ((!Array.isArray(insumo.observaciones) || insumo.observaciones.length === 0) && insumo.ultima_nota) {
      const legacy = sanitizeOptionalText(insumo.ultima_nota, { max: 500 }) || '';
      if (legacy.trim()) {
        insumo.observaciones = [
          {
            texto: legacy.trim(),
            creado_por: req.userId || null,
            creado_en: new Date(),
            actualizado_en: new Date()
          }
        ];
        insumo.actualizado_en = new Date();
        await insumo.save();
      }
    }

    const observaciones = (Array.isArray(insumo.observaciones) ? insumo.observaciones : [])
      .map((obs) => ({
        _id: obs._id,
        texto: obs.texto || '',
        creado_por: obs.creado_por || null,
        creado_en: obs.creado_en || null,
        actualizado_en: obs.actualizado_en || null
      }))
      .sort((a, b) => new Date(b.actualizado_en || b.creado_en || 0) - new Date(a.actualizado_en || a.creado_en || 0));

    res.json(observaciones);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener observaciones' });
  }
});

router.post('/:id/observaciones', async (req, res) => {
  try {
    if (!puedeGestionarObservaciones(req.userRole)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const texto = sanitizeOptionalText(req.body.texto, { max: 500 }) || '';
    if (!texto.trim()) {
      return res.status(400).json({ error: 'La observacion es requerida' });
    }

    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId });
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });

    insumo.observaciones.push({
      texto: texto.trim(),
      creado_por: req.userId || null,
      creado_en: new Date(),
      actualizado_en: new Date()
    });
    insumo.actualizado_en = new Date();
    await insumo.save();

    res.status(201).json(insumo.observaciones[insumo.observaciones.length - 1]);
  } catch (error) {
    res.status(500).json({ error: 'Error al crear observacion' });
  }
});

router.put('/:id/observaciones/:obsId', async (req, res) => {
  try {
    if (!puedeGestionarObservaciones(req.userRole)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const texto = sanitizeOptionalText(req.body.texto, { max: 500 }) || '';
    if (!texto.trim()) {
      return res.status(400).json({ error: 'La observacion es requerida' });
    }

    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId });
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });

    const observacion = insumo.observaciones.id(req.params.obsId);
    if (!observacion) return res.status(404).json({ error: 'Observacion no encontrada' });

    observacion.texto = texto.trim();
    observacion.actualizado_en = new Date();
    insumo.actualizado_en = new Date();
    await insumo.save();

    res.json({
      _id: observacion._id,
      texto: observacion.texto,
      creado_por: observacion.creado_por || null,
      creado_en: observacion.creado_en || null,
      actualizado_en: observacion.actualizado_en || null
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar observacion' });
  }
});

router.delete('/:id/observaciones/:obsId', async (req, res) => {
  try {
    if (!puedeGestionarObservaciones(req.userRole)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId });
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });

    const observacion = insumo.observaciones.id(req.params.obsId);
    if (!observacion) return res.status(404).json({ error: 'Observacion no encontrada' });

    observacion.deleteOne();
    insumo.actualizado_en = new Date();
    await insumo.save();

    res.json({ mensaje: 'Observacion eliminada' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar observacion' });
  }
});

router.put('/:id/estado', async (req, res) => {
  try {
    const activo = req.body?.activo;
    if (typeof activo !== 'boolean') {
      return res.status(400).json({ error: 'Estado invalido' });
    }
    const insumo = await Insumo.findOneAndUpdate(
      { _id: req.params.id, local: req.localId },
      { activo, actualizado_en: new Date() },
      { new: true }
    );
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });
    res.json(insumo);
  } catch (error) {
    console.error('Error al actualizar insumo:', error);
    res.status(500).json({ error: error.message || 'Error al actualizar insumo' });
  }
});

router.get('/alertas/config', async (req, res) => {
  try {
    const config = await InsumoAlertaConfig.findOne({ local: req.localId });
    res.json({ usuarios: config?.usuarios || [] });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener configuracion de alertas' });
  }
});

router.put('/alertas/config', async (req, res) => {
  try {
    if (req.userRole !== 'superadmin') {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const usuariosRaw = Array.isArray(req.body.usuarios) ? req.body.usuarios : [];
    const ids = usuariosRaw.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const usuarios = await Usuario.find(
      {
        _id: { $in: ids },
        $or: [{ local: req.localId }, { rol: 'superadmin' }]
      },
      '_id'
    );
    const usuariosValidos = usuarios.map((u) => u._id);
    const config = await InsumoAlertaConfig.findOneAndUpdate(
      { local: req.localId },
      { usuarios: usuariosValidos, actualizado_en: new Date() },
      { upsert: true, new: true }
    );
    res.json({ usuarios: config.usuarios });
  } catch (error) {
    res.status(500).json({ error: 'Error al guardar configuracion de alertas' });
  }
});

router.post('/alertas/resumen', async (req, res) => {
  try {
    if (req.userRole !== 'superadmin') {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const destinatarios = await obtenerDestinatarios(req.localId);
    if (destinatarios.length === 0) {
      return res.status(400).json({ error: 'No hay destinatarios configurados' });
    }
    const insumos = await Insumo.find({
      local: req.localId,
      $or: [{ activo: true }, { activo: { $exists: false } }]
    });
    const insumosBajos = insumos.filter(
      (insumo) => Number(insumo.stock_total || 0) <= Number(insumo.stock_minimo || 0)
    );
    if (insumosBajos.length === 0) {
      return res.json({ mensaje: 'No hay alertas para enviar' });
    }

    const subject = 'Resumen diario de stock bodega';
    const html = `
      <h3>Resumen diario de stock bodega</h3>
      ${insumosBajos.length ? `<h4>Stock bajo</h4><ul>${insumosBajos
        .map((insumo) => `<li>${insumo.nombre}: ${insumo.stock_total} (min ${insumo.stock_minimo})</li>`)
        .join('')}</ul>` : '<p>Sin productos de bodega con stock bajo.</p>'}
    `;

    await sendMail({
      to: destinatarios.map((d) => d.email).join(','),
      subject,
      html,
      text: 'Resumen diario de stock bodega'
    });

    res.json({ mensaje: 'Resumen enviado' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error al enviar resumen' });
  }
});

router.post('/clonar', async (req, res) => {
  try {
    if (req.userRole !== 'superadmin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const sourceLocalId = req.body.sourceLocalId || req.localId;
    const targetLocalId = req.body.targetLocalId;
    const insumoId = req.body.insumoId;
    const clonarTodos = Boolean(req.body.clonarTodos);

    if (!mongoose.Types.ObjectId.isValid(sourceLocalId || '')) {
      return res.status(400).json({ error: 'Local origen invalido' });
    }
    if (!mongoose.Types.ObjectId.isValid(targetLocalId || '')) {
      return res.status(400).json({ error: 'Local destino invalido' });
    }
    if (String(sourceLocalId) === String(targetLocalId)) {
      return res.status(400).json({ error: 'El local destino debe ser distinto' });
    }

    const [sourceLocal, targetLocal] = await Promise.all([
      Local.findById(sourceLocalId),
      Local.findById(targetLocalId)
    ]);
    if (!sourceLocal || !targetLocal) {
      return res.status(400).json({ error: 'Local no encontrado' });
    }

    let origen = [];
    if (clonarTodos) {
      origen = await Insumo.find({
        local: sourceLocalId,
        $or: [{ activo: true }, { activo: { $exists: false } }]
      }).lean();
      if (!origen.length) {
        return res.status(400).json({ error: 'No hay insumos para clonar' });
      }
    } else {
      if (!mongoose.Types.ObjectId.isValid(insumoId || '')) {
        return res.status(400).json({ error: 'Insumo invalido' });
      }
      const insumo = await Insumo.findOne({ _id: insumoId, local: sourceLocalId }).lean();
      if (!insumo) {
        return res.status(404).json({ error: 'Insumo no encontrado' });
      }
      origen = [insumo];
    }

    let creados = 0;
    let omitidos = 0;
    const nuevos = [];

    for (const insumo of origen) {
      const existe = await Insumo.findOne({
        local: targetLocalId,
        nombre: insumo.nombre
      }).lean();
      if (existe) {
        omitidos += 1;
        continue;
      }
      nuevos.push({
        nombre: insumo.nombre,
        descripcion: insumo.descripcion || '',
        sku: insumo.sku || '',
        color: insumo.color || '',
        talla: insumo.talla || '',
        imagen_url: insumo.imagen_url || '',
        producto_relacionado: null,
        variante_relacionada: null,
        unidad: insumo.unidad,
        stock_total: 0,
        stock_minimo: insumo.stock_minimo || 0,
        alerta_vencimiento_dias: insumo.alerta_vencimiento_dias || 7,
        local: targetLocalId,
        activo: true,
        creado_en: new Date(),
        actualizado_en: new Date()
      });
    }

    if (nuevos.length) {
      await Insumo.insertMany(nuevos);
      creados = nuevos.length;
    }

    res.json({
      mensaje: `Clonado completado. Creados: ${creados}, Omitidos: ${omitidos}`,
      creados,
      omitidos
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al clonar insumos' });
  }
});

router.post('/importar-productos', async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.userRole)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const importarTodos = Boolean(req.body?.importarTodos);
    const productoIdsRaw = Array.isArray(req.body?.productoIds) ? req.body.productoIds : [];
    const productoIds = Array.from(
      new Set(productoIdsRaw.map((id) => String(id || '').trim()).filter((id) => mongoose.Types.ObjectId.isValid(id)))
    );

    if (!importarTodos && productoIds.length === 0) {
      return res.status(400).json({ error: 'Debes seleccionar al menos un producto' });
    }

    const filtro = { local: req.localId };
    if (!importarTodos) {
      filtro._id = { $in: productoIds };
    }

    const productos = await ProductoLocal.find(filtro)
      .populate('productoBase', 'nombre descripcion sku imagen_url')
      .lean();

    if (!productos.length) {
      return res.status(400).json({ error: 'No se encontraron productos para importar' });
    }

    const existentes = await Insumo.find({ local: req.localId })
      .select('producto_relacionado variante_relacionada nombre sku color talla')
      .lean();

    const relacionesExistentes = new Set(
      existentes.map((item) => {
        const prod = String(item?.producto_relacionado || '');
        const vari = String(item?.variante_relacionada || '');
        return `${prod}::${vari}`;
      })
    );

    const coincidenciasTexto = new Set(
      existentes.map((item) =>
        [
          normalizarTexto(item?.nombre),
          normalizarTexto(item?.sku),
          normalizarTexto(item?.color),
          normalizarTexto(item?.talla)
        ].join('::')
      )
    );

    const nuevos = [];
    let omitidos = 0;

    for (const producto of productos) {
      const base = producto?.productoBase || {};
      const variantes = Array.isArray(producto?.variantes) ? producto.variantes : [];

      if (variantes.length > 0) {
        for (const variante of variantes) {
          const relationKey = `${String(producto._id)}::${String(variante?._id || '')}`;
          const textKey = [
            normalizarTexto(base.nombre),
            normalizarTexto(variante?.sku || base.sku),
            normalizarTexto(variante?.color),
            normalizarTexto(variante?.talla)
          ].join('::');

          if (relacionesExistentes.has(relationKey) || coincidenciasTexto.has(textKey)) {
            omitidos += 1;
            continue;
          }

          nuevos.push({
            nombre: base.nombre || 'Producto sin nombre',
            descripcion: base.descripcion || '',
            sku: variante?.sku || base.sku || '',
            color: variante?.color || '',
            talla: variante?.talla || '',
            imagen_url: base.imagen_url || '',
            producto_relacionado: producto._id,
            variante_relacionada: variante?._id || null,
            unidad: 'unid',
            stock_total: 0,
            stock_minimo: 0,
            alerta_vencimiento_dias: 7,
            local: req.localId,
            activo: true,
            creado_en: new Date(),
            actualizado_en: new Date()
          });
          relacionesExistentes.add(relationKey);
          coincidenciasTexto.add(textKey);
        }
        continue;
      }

      const relationKey = `${String(producto._id)}::`;
      const textKey = [
        normalizarTexto(base.nombre),
        normalizarTexto(base.sku),
        '',
        ''
      ].join('::');

      if (relacionesExistentes.has(relationKey) || coincidenciasTexto.has(textKey)) {
        omitidos += 1;
        continue;
      }

      nuevos.push({
        nombre: base.nombre || 'Producto sin nombre',
        descripcion: base.descripcion || '',
        sku: base.sku || '',
        color: '',
        talla: '',
        imagen_url: base.imagen_url || '',
        producto_relacionado: producto._id,
        variante_relacionada: null,
        unidad: 'unid',
        stock_total: 0,
        stock_minimo: 0,
        alerta_vencimiento_dias: 7,
        local: req.localId,
        activo: true,
        creado_en: new Date(),
        actualizado_en: new Date()
      });
      relacionesExistentes.add(relationKey);
      coincidenciasTexto.add(textKey);
    }

    if (!nuevos.length) {
      return res.json({
        mensaje: 'No habia productos nuevos para importar',
        creados: 0,
        omitidos
      });
    }

    await Insumo.insertMany(nuevos);

    return res.json({
      mensaje: `Importacion completada. Creados: ${nuevos.length}, Omitidos: ${omitidos}`,
      creados: nuevos.length,
      omitidos
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error al importar productos' });
  }
});

router.post('/', upload.single('imagen'), async (req, res) => {
  try {
    const nombre = sanitizeText(req.body.nombre, { max: 120 });
    const descripcion = sanitizeOptionalText(req.body.descripcion, { max: 300 }) || '';
    const sku = sanitizeOptionalText(req.body.sku, { max: 60 }) || '';
    const color = sanitizeOptionalText(req.body.color, { max: 60 }) || '';
    const talla = sanitizeOptionalText(req.body.talla, { max: 60 }) || '';
    const unidad = sanitizeText(req.body.unidad || 'unid', { max: 20 });
    const imagenUrlBody = sanitizeOptionalText(req.body.imagen_url, { max: 600 }) || '';
    let categoriaRaw = req.body.categoria;
    if (categoriaRaw && typeof categoriaRaw === 'object' && categoriaRaw._id) {
      categoriaRaw = categoriaRaw._id;
    }
    const stockTotalRaw = req.body.stock_total;
    const stockMinimo = toNumberOrNull(req.body.stock_minimo);
    const alertaVenc = toNumberOrNull(req.body.alerta_vencimiento_dias);
    const productoRelacionadoRaw = req.body.producto_relacionado;
    const varianteRelacionadaRaw = req.body.variante_relacionada;

    if (!nombre || !unidad) {
      return res.status(400).json({ error: 'Nombre y unidad son requeridos' });
    }

    let imagen_url = '';
    if (req.file) {
      const subida = await subirImagen(req.file);
      imagen_url = subida.secure_url;
    } else if (imagenUrlBody) {
      if (!isValidHttpUrl(imagenUrlBody)) {
        return res.status(400).json({ error: 'La URL de imagen es invalida' });
      }
      imagen_url = imagenUrlBody;
    }

    const existe = await Insumo.findOne(
      construirFiltroDuplicadoInsumo({
        nombre,
        sku,
        color,
        talla,
        localId: req.localId
      })
    );
    if (existe) {
      return res.status(400).json({ error: 'Ya existe un producto bodega con esos datos' });
    }

    let categoriaId = null;
    if (categoriaRaw) {
      if (!mongoose.Types.ObjectId.isValid(categoriaRaw)) {
        return res.status(400).json({ error: 'Categoria invalida' });
      }
      categoriaId = categoriaRaw;
    }

    let relacionProducto;
    try {
      relacionProducto = await resolverRelacionProducto({
        productoIdRaw: productoRelacionadoRaw,
        varianteIdRaw: varianteRelacionadaRaw,
        localId: req.localId
      });
    } catch (validationError) {
      return res.status(400).json({ error: validationError.message });
    }

    const nuevo = new Insumo({
      nombre,
      descripcion,
      sku,
      color,
      talla,
      imagen_url,
      producto_relacionado: relacionProducto.productoId,
      variante_relacionada: relacionProducto.varianteId,
      unidad,
      stock_minimo: stockMinimo ?? 0,
      alerta_vencimiento_dias: alertaVenc ?? 7,
      categoria: categoriaId,
      local: req.localId
    });
    const guardado = await nuevo.save();
    res.status(201).json(guardado);
  } catch (error) {
    res.status(500).json({ error: 'Error al crear insumo' });
  }
});

router.put('/:id', upload.single('imagen'), async (req, res) => {
  try {
    console.log('PUT /insumos/:id body', req.body);
    const nombre = sanitizeText(req.body.nombre, { max: 120 });
    const descripcion = sanitizeOptionalText(req.body.descripcion, { max: 300 }) || '';
    const sku = sanitizeOptionalText(req.body.sku, { max: 60 }) || '';
    const color = sanitizeOptionalText(req.body.color, { max: 60 }) || '';
    const talla = sanitizeOptionalText(req.body.talla, { max: 60 }) || '';
    const unidad = sanitizeText(req.body.unidad || 'unid', { max: 20 });
    const imagenUrlBody = sanitizeOptionalText(req.body.imagen_url, { max: 600 }) || '';
    let categoriaRaw = req.body.categoria;
    if (categoriaRaw && typeof categoriaRaw === 'object' && categoriaRaw._id) {
      categoriaRaw = categoriaRaw._id;
    }
    const stockTotalRaw = req.body.stock_total;
    const stockMinimo = toNumberOrNull(req.body.stock_minimo);
    const alertaVenc = toNumberOrNull(req.body.alerta_vencimiento_dias);
    const productoRelacionadoRaw = req.body.producto_relacionado;
    const varianteRelacionadaRaw = req.body.variante_relacionada;

    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId });
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });

    if (nombre) {
      const duplicado = await Insumo.findOne(
        construirFiltroDuplicadoInsumo({
          nombre,
          sku,
          color,
          talla,
          localId: req.localId,
          excludeId: req.params.id
        })
      );
      if (duplicado) {
        return res.status(400).json({ error: 'Ya existe un producto bodega con esos datos' });
      }
    }

    if (nombre) insumo.nombre = nombre;
    if (unidad) insumo.unidad = unidad;
    insumo.descripcion = descripcion;
    insumo.sku = sku;
    insumo.color = color;
    insumo.talla = talla;
    if (req.file) {
      const subida = await subirImagen(req.file);
      insumo.imagen_url = subida.secure_url;
    } else if (req.body.imagen_url !== undefined) {
      if (imagenUrlBody && !isValidHttpUrl(imagenUrlBody)) {
        return res.status(400).json({ error: 'La URL de imagen es invalida' });
      }
      insumo.imagen_url = imagenUrlBody;
    }
    if (stockMinimo !== null) insumo.stock_minimo = stockMinimo;
    if (alertaVenc !== null) insumo.alerta_vencimiento_dias = alertaVenc;
    if (stockTotalRaw !== undefined) {
      const stockTotal = toNumberOrNull(stockTotalRaw);
      if (stockTotal === null || stockTotal < 0) {
        return res.status(400).json({ error: 'Stock total invalido' });
      }
      insumo.stock_total = stockTotal;
    }
    if (categoriaRaw !== undefined) {
      if (categoriaRaw === null || String(categoriaRaw).trim() === '') {
        insumo.categoria = null;
      } else if (!mongoose.Types.ObjectId.isValid(categoriaRaw)) {
        return res.status(400).json({ error: 'Categoria invalida' });
      } else {
        insumo.categoria = categoriaRaw;
      }
    }
    if (productoRelacionadoRaw !== undefined || varianteRelacionadaRaw !== undefined) {
      let relacionProducto;
      try {
        relacionProducto = await resolverRelacionProducto({
          productoIdRaw: productoRelacionadoRaw,
          varianteIdRaw: varianteRelacionadaRaw,
          localId: req.localId
        });
      } catch (validationError) {
        return res.status(400).json({ error: validationError.message });
      }
      insumo.producto_relacionado = relacionProducto.productoId;
      insumo.variante_relacionada = relacionProducto.varianteId;
    }
    insumo.actualizado_en = new Date();

    const actualizado = await insumo.save();
    res.json(actualizado);
  } catch (error) {
    console.error('Error al actualizar insumo:', error);
    console.error('Body recibido:', req.body);
    res.status(500).json({ error: error.message || 'Error al actualizar insumo' });
  }
});

router.delete('/movimientos', async (req, res) => {
  try {
    console.log('DELETE /insumos/movimientos', {
      localId: req.localId,
      userRole: req.userRole,
      query: req.query
    });
    if (req.userRole !== 'superadmin') {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const filtro = { local: req.localId };
    if (req.query?.insumo) {
      if (!mongoose.Types.ObjectId.isValid(req.query.insumo)) {
        return res.status(400).json({ error: 'Insumo invalido' });
      }
      filtro.insumo = req.query.insumo;
    }
    const result = await InsumoMovimiento.deleteMany(filtro);
    res.json({ mensaje: 'Movimientos eliminados', eliminados: result.deletedCount || 0 });
  } catch (error) {
    console.error('Error al eliminar movimientos:', error);
    res.status(500).json({ error: error.message || 'Error al eliminar movimientos' });
  }
});

router.delete('/movimientos/:movId', async (req, res) => {
  try {
    if (req.userRole !== 'superadmin') {
      return res.status(403).json({ error: 'No autorizado' });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.movId)) {
      return res.status(400).json({ error: 'Movimiento invalido' });
    }
    const movimiento = await InsumoMovimiento.findOneAndDelete({
      _id: req.params.movId,
      local: req.localId
    });
    if (!movimiento) return res.status(404).json({ error: 'Movimiento no encontrado' });
    res.json({ mensaje: 'Movimiento eliminado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar movimiento' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.userRole)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId });
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });

    await Promise.all([
      Insumo.deleteOne({ _id: req.params.id, local: req.localId }),
      InsumoLote.deleteMany({ insumo: req.params.id, local: req.localId }),
      InsumoMovimiento.deleteMany({ insumo: req.params.id, local: req.localId })
    ]);
    res.json({ mensaje: 'Insumo eliminado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar insumo' });
  }
});

router.get('/:id/lotes', async (req, res) => {
  try {
    const incluirOcultos = String(req.query?.incluir_ocultos) === 'true';
    const incluirSinInfo = String(req.query?.incluir_sin_info) === 'true';
    const filtro = { insumo: req.params.id, local: req.localId };
    if (!incluirOcultos) {
      filtro.$or = [{ activo: true }, { activo: { $exists: false } }];
    }
    if (!incluirSinInfo) {
      filtro.$and = [
        {
          $or: [
            { lote: { $exists: true, $ne: '' } },
            { fecha_vencimiento: { $ne: null } }
          ]
        }
      ];
    }
    const lotes = await InsumoLote.find(filtro).sort({ fecha_ingreso: 1 });
    res.json(lotes);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener lotes' });
  }
});

router.post('/:id/lotes', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const loteNombre = sanitizeOptionalText(req.body.lote, { max: 80 }) || '';
    const fechaVenc = req.body.fecha_vencimiento ? new Date(req.body.fecha_vencimiento) : null;
    const cantidad = req.body.cantidad === undefined || req.body.cantidad === null || req.body.cantidad === ''
      ? 0
      : parsePositiveNumber(req.body.cantidad, 'cantidad');

    if (!loteNombre && !fechaVenc) {
      return res.status(400).json({ error: 'Debes indicar un lote o una fecha de vencimiento' });
    }

    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId }).session(session);
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });
    if (insumo.activo === false) {
      return res.status(400).json({ error: 'El insumo esta oculto' });
    }

    const nuevoLote = new InsumoLote({
      insumo: insumo._id,
      local: req.localId,
      lote: loteNombre || undefined,
      fecha_vencimiento: fechaVenc || null,
      cantidad,
      fecha_ingreso: new Date()
    });
    await nuevoLote.save({ session });

    if (cantidad > 0) {
      insumo.stock_total += cantidad;
      insumo.ultima_nota = null;
      insumo.actualizado_en = new Date();
      await insumo.save({ session });

      const movimiento = new InsumoMovimiento({
        insumo: insumo._id,
        local: req.localId,
        lote: nuevoLote._id,
        tipo: 'entrada',
        cantidad,
        motivo: 'Registro de lote',
        usuario: req.userId || null
      });
      await movimiento.save({ session });
    }

    await session.commitTransaction();
    res.status(201).json(nuevoLote);
  } catch (error) {
    await session.abortTransaction().catch(() => {});
    res.status(400).json({ error: error.message || 'Error al crear lote' });
  } finally {
    session.endSession();
  }
});

router.put('/:id/lotes/:loteId/estado', async (req, res) => {
  try {
    const activo = req.body?.activo;
    if (typeof activo !== 'boolean') {
      return res.status(400).json({ error: 'Estado invalido' });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.loteId)) {
      return res.status(400).json({ error: 'Lote invalido' });
    }
    const lote = await InsumoLote.findOneAndUpdate(
      {
        _id: req.params.loteId,
        insumo: req.params.id,
        local: req.localId
      },
      { activo },
      { new: true }
    );
    if (!lote) {
      return res.status(404).json({ error: 'Lote no encontrado' });
    }
    res.json(lote);
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar lote' });
  }
});

router.delete('/:id/lotes', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId }).session(session);
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });

    const lotes = await InsumoLote.find({ insumo: req.params.id, local: req.localId }).session(session);
    const totalLotes = lotes.reduce((acc, lote) => acc + (lote.cantidad || 0), 0);

    await InsumoLote.deleteMany({ insumo: req.params.id, local: req.localId }).session(session);

    insumo.stock_total = Math.max(0, Number(insumo.stock_total || 0) - totalLotes);
    await insumo.save({ session });

    await InsumoMovimiento.deleteMany({ insumo: req.params.id, local: req.localId }).session(session);

    await session.commitTransaction();
    res.json({ mensaje: 'Lotes eliminados' });
  } catch (error) {
    await session.abortTransaction().catch(() => {});
    res.status(500).json({ error: 'Error al eliminar lotes' });
  } finally {
    session.endSession();
  }
});

router.delete('/:id/lotes/:loteId', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId }).session(session);
    if (!insumo) return res.status(404).json({ error: 'Insumo no encontrado' });

    if (!mongoose.Types.ObjectId.isValid(req.params.loteId)) {
      return res.status(400).json({ error: 'Lote invalido' });
    }

    const lote = await InsumoLote.findOne({
      _id: req.params.loteId,
      insumo: req.params.id,
      local: req.localId
    }).session(session);
    if (!lote) return res.status(404).json({ error: 'Lote no encontrado' });

    await InsumoLote.deleteOne({ _id: lote._id }).session(session);
    insumo.stock_total = Math.max(0, Number(insumo.stock_total || 0) - Number(lote.cantidad || 0));
    await insumo.save({ session });

    await InsumoMovimiento.deleteMany({ lote: lote._id, local: req.localId }).session(session);

    await session.commitTransaction();
    res.json({ mensaje: 'Lote eliminado' });
  } catch (error) {
    await session.abortTransaction().catch(() => {});
    res.status(500).json({ error: 'Error al eliminar lote' });
  } finally {
    session.endSession();
  }
});

router.get('/movimientos', async (req, res) => {
  try {
    const filtro = { local: req.localId };
    if (req.query?.insumo) {
      if (!mongoose.Types.ObjectId.isValid(req.query.insumo)) {
        return res.status(400).json({ error: 'Insumo invalido' });
      }
      filtro.insumo = req.query.insumo;
    }
    const movimientos = await InsumoMovimiento.find(filtro)
      .populate('insumo', 'nombre sku color talla')
      .sort({ fecha: -1 });
    res.json(movimientos);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

router.get('/:id/movimientos', async (req, res) => {
  try {
    const movimientos = await InsumoMovimiento.find({
      insumo: req.params.id,
      local: req.localId
    })
      .populate('insumo', 'nombre sku color talla')
      .sort({ fecha: -1 });
    res.json(movimientos);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

router.post('/:id/movimientos', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const tipo = sanitizeText(req.body.tipo, { max: 10 });
    const cantidad = parsePositiveNumber(req.body.cantidad, 'cantidad');
    const motivo = sanitizeOptionalText(req.body.motivo, { max: 200 }) || '';
    const nota = sanitizeOptionalText(req.body.nota, { max: 500 }) || '';
    const loteId = req.body.loteId;
    const loteNombre = sanitizeOptionalText(req.body.lote, { max: 80 }) || '';
    const fechaVenc = req.body.fecha_vencimiento ? new Date(req.body.fecha_vencimiento) : null;

    if (!tipo || !['entrada', 'salida'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de movimiento invalido' });
    }

    const insumo = await Insumo.findOne({ _id: req.params.id, local: req.localId }).session(session);
    if (!insumo) {
      return res.status(404).json({ error: 'Insumo no encontrado' });
    }
    if (insumo.activo === false) {
      return res.status(400).json({ error: 'El insumo esta oculto' });
    }

    let lote = null;
    if (tipo === 'entrada') {
      if (loteId) {
        if (!mongoose.Types.ObjectId.isValid(loteId)) {
          return res.status(400).json({ error: 'Lote invalido' });
        }
        lote = await InsumoLote.findOne({ _id: loteId, local: req.localId }).session(session);
        if (!lote) {
          return res.status(404).json({ error: 'Lote no encontrado' });
        }
        if (lote.activo === false) {
          return res.status(400).json({ error: 'El lote esta oculto' });
        }
        lote.cantidad += cantidad;
        await lote.save({ session });
      } else if (loteNombre || fechaVenc) {
        lote = new InsumoLote({
          insumo: insumo._id,
          local: req.localId,
          lote: loteNombre || undefined,
          fecha_vencimiento: fechaVenc || null,
          cantidad,
          fecha_ingreso: new Date()
        });
        await lote.save({ session });
      }
      insumo.stock_total += cantidad;
    } else {
      if (loteId) {
        if (!mongoose.Types.ObjectId.isValid(loteId)) {
          return res.status(400).json({ error: 'Lote invalido' });
        }
        lote = await InsumoLote.findOne({ _id: loteId, local: req.localId }).session(session);
        if (!lote) {
          return res.status(404).json({ error: 'Lote no encontrado' });
        }
        if (lote.activo === false) {
          return res.status(400).json({ error: 'El lote esta oculto' });
        }
        if (lote.cantidad < cantidad) {
          return res.status(400).json({ error: 'Cantidad supera el stock del lote' });
        }
        lote.cantidad -= cantidad;
        await lote.save({ session });
      } else {
        const lotesDisponibles = await InsumoLote.find({
          insumo: insumo._id,
          local: req.localId,
          $or: [{ activo: true }, { activo: { $exists: false } }],
          cantidad: { $gt: 0 }
        })
          .sort({ fecha_ingreso: 1 })
          .session(session);

        const totalDisponible = lotesDisponibles.reduce((acc, item) => acc + (item.cantidad || 0), 0);
        const stockTotalActual = Number(insumo.stock_total || 0);
        if (stockTotalActual < cantidad) {
          return res.status(400).json({ error: 'Cantidad supera el stock disponible' });
        }

        let restante = cantidad;
        for (const item of lotesDisponibles) {
          if (restante <= 0) break;
          const consumir = Math.min(item.cantidad, restante);
          item.cantidad -= consumir;
          restante -= consumir;
          await item.save({ session });
          if (!lote) {
            lote = item;
          }
        }
      }

      insumo.stock_total = Math.max(0, insumo.stock_total - cantidad);
      await sincronizarSalidaBodegaConProducto({
        insumo,
        cantidad,
        localId: req.localId,
        session
      });
    }

    const notaFinal = nota ? String(nota).trim() : '';
    insumo.ultima_nota = notaFinal ? notaFinal : null;
    insumo.actualizado_en = new Date();
    await insumo.save({ session });

    const movimiento = new InsumoMovimiento({
      insumo: insumo._id,
      local: req.localId,
      lote: lote?._id || null,
      tipo: tipo === 'entrada' ? 'entrada' : 'salida',
      cantidad,
      motivo,
      nota: nota || undefined,
      usuario: req.userId || null
    });
    await movimiento.save({ session });

    await session.commitTransaction();
    res.status(201).json({ mensaje: 'Movimiento registrado', lote });

    setImmediate(async () => {
      try {
        const destinatarios = await obtenerDestinatarios(req.localId);
        if (destinatarios.length === 0) return;

        const refreshed = await Insumo.findById(insumo._id);
        if (!refreshed) return;
        if (refreshed.activo === false) return;

        const alertaStock = Number(refreshed.stock_total || 0) <= Number(refreshed.stock_minimo || 0);
        const hoy = new Date();

        let debeAlertarStock = false;
        if (alertaStock) {
          const ultima = refreshed.last_alerta_stock_en ? new Date(refreshed.last_alerta_stock_en) : null;
          if (!sameDay(ultima, hoy)) {
            debeAlertarStock = true;
          }
        }

        if (!debeAlertarStock) return;

        const subject = `Alerta de stock bodega - ${refreshed.nombre}`;
        const html = `
          <h3>Alerta de stock bodega</h3>
          <p><strong>${refreshed.nombre}</strong></p>
          ${debeAlertarStock ? `<p>Stock bajo: ${refreshed.stock_total} (min ${refreshed.stock_minimo})</p>` : ''}
        `;

        await sendMail({
          to: destinatarios.map((d) => d.email).join(','),
          subject,
          html,
          text: subject
        });

        const update = {};
        if (debeAlertarStock) update.last_alerta_stock_en = hoy;
        if (Object.keys(update).length) {
          await Insumo.updateOne({ _id: refreshed._id }, update);
        }
      } catch (err) {
        // ignore email errors to avoid breaking request
      }
    });
  } catch (error) {
    await session.abortTransaction().catch(() => {});
    res.status(400).json({ error: error.message || 'Error al registrar movimiento' });
  } finally {
    session.endSession();
  }
});

module.exports = router;
