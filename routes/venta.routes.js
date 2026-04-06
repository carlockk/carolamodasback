const express = require('express');
const mongoose = require('mongoose');
const Venta = require('../models/venta.model.js');
const VentaCliente = require('../models/ventaCliente.model.js');
const ProductoLocal = require('../models/productLocal.model.js');
const Caja = require('../models/caja.model.js');
const { sanitizeText, sanitizeOptionalText } = require('../utils/input');
const { adjuntarScopeLocal, requiereLocal } = require('../middlewares/localScope');

const router = express.Router();
router.use(adjuntarScopeLocal);
router.use(requiereLocal);

const obtenerAtributosVariante = (variante) => {
  if (!variante) return [];
  const atributos = [];
  if (variante.color) atributos.push({ nombre: 'Color', valor: variante.color });
  if (variante.talla) atributos.push({ nombre: 'Talla', valor: variante.talla });
  if (variante.sku) atributos.push({ nombre: 'SKU', valor: variante.sku });
  return atributos;
};

const normalizarAgregadosVenta = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((agg) => {
      const nombre = sanitizeOptionalText(agg?.nombre, { max: 80 }) || '';
      if (!nombre) return null;
      const precio = Number(agg?.precio);
      return {
        agregadoId: mongoose.Types.ObjectId.isValid(agg?.agregadoId) ? agg.agregadoId : null,
        nombre,
        precio: Number.isFinite(precio) && precio > 0 ? precio : 0
      };
    })
    .filter(Boolean);
};

const calcularStockDesdeVariantes = (variantes = []) =>
  variantes.reduce((acc, variante) => acc + (variante.stock || 0), 0);

const consolidarVentas = (ventasPos = [], ventasWeb = []) => ([
  ...ventasPos.map((venta) => ({ ...venta.toObject(), canal: 'POS' })),
  ...ventasWeb.map((venta) => ({ ...venta.toObject(), canal: 'WEB' }))
]);

const armarDesglosePorTipoProducto = async (ventas = [], localId) => {
  const ids = new Set();
  ventas.forEach((venta) => {
    venta.productos?.forEach((item) => {
      if (item?.productoId) {
        ids.add(item.productoId.toString());
      }
    });
  });

  if (ids.size === 0) {
    return {};
  }

  const idsArray = [...ids];
  const productosLocal = await ProductoLocal.find({
    _id: { $in: idsArray },
    local: localId
  }).populate({
    path: 'productoBase',
    populate: { path: 'categoria', select: 'nombre' }
  });

  const categoriaPorProducto = new Map();
  productosLocal.forEach((producto) => {
    const categoriaNombre = producto.productoBase?.categoria?.nombre || 'Sin categoria';
    categoriaPorProducto.set(producto._id.toString(), categoriaNombre);
  });

  const porTipoProducto = {};
  ventas.forEach((venta) => {
    venta.productos?.forEach((item) => {
      const productoId = item?.productoId ? item.productoId.toString() : null;
      const categoria = productoId && categoriaPorProducto.get(productoId)
        ? categoriaPorProducto.get(productoId)
        : 'Sin categoria';
      const precio = Number(item?.precio_unitario) || 0;
      const cantidad = Number(item?.cantidad) || 0;
      const subtotal = precio * cantidad;

      if (subtotal <= 0) return;
      porTipoProducto[categoria] = (porTipoProducto[categoria] || 0) + subtotal;
    });
  });

  return porTipoProducto;
};

const armarResumenPorProducto = (ventas = []) => {
  const porProducto = new Map();

  ventas.forEach((venta) => {
    venta.productos?.forEach((item) => {
      const nombre = item?.nombre || 'Producto sin nombre';
      const cantidad = Number(item?.cantidad) || 0;
      const precio = Number(item?.precio_unitario) || 0;
      if (cantidad <= 0 || precio < 0) return;

      const actual = porProducto.get(nombre) || { nombre, cantidad: 0, total: 0 };
      actual.cantidad += cantidad;
      actual.total += cantidad * precio;
      porProducto.set(nombre, actual);
    });
  });

  return [...porProducto.values()].sort((a, b) => b.total - a.total);
};

const armarDesglosePorTipoPago = (ventas = []) => {
  const porTipoPago = {};
  const porTipoPagoDetallado = { POS: {}, WEB: {} };

  ventas.forEach((venta) => {
    const tipoPago = venta.tipo_pago || 'Otro';
    const total = Number(venta.total) || 0;
    const canal = venta.canal === 'WEB' ? 'WEB' : 'POS';
    const llaveConCanal = `${tipoPago} (${canal})`;

    porTipoPago[llaveConCanal] = (porTipoPago[llaveConCanal] || 0) + total;
    porTipoPagoDetallado[canal][tipoPago] = (porTipoPagoDetallado[canal][tipoPago] || 0) + total;
  });

  return { porTipoPago, porTipoPagoDetallado };
};

/**
 * @swagger
 * tags:
 *   name: Ventas
 *   description: Gestión de ventas del sistema POS
 */

/**
 * @swagger
 * /ventas:
 *   get:
 *     summary: Obtener historial de todas las ventas
 *     tags: [Ventas]
 *     responses:
 *       200:
 *         description: Lista de ventas ordenadas por fecha descendente
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       500:
 *         description: Error interno del servidor
 */
router.get('/', async (req, res) => {
  try {
    const filtro = { local: req.localId };
    if (req.userRole === 'cajero') {
      if (!req.userId) {
        return res.status(400).json({ error: 'Usuario requerido' });
      }
      filtro.usuario = req.userId;
    }

    const ventas = await Venta.find(filtro)
      .populate('usuario', 'nombre email rol')
      .sort({ fecha: -1 });
    res.json(ventas);
  } catch (err) {
    console.error('Error al obtener historial:', err);
    res.status(500).json({ error: 'Error interno al obtener historial' });
  }
});

/**
 * @swagger
 * /ventas/resumen:
 *   get:
 *     summary: Obtener resumen de ventas por fecha
 *     tags: [Ventas]
 *     parameters:
 *       - name: fecha
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *           example: "2024-07-19"
 *     responses:
 *       200:
 *         description: Resumen con total, cantidad y pagos por tipo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: number
 *                 cantidad:
 *                   type: number
 *                 porTipoPago:
 *                   type: object
 *                 porTipoProducto:
 *                   type: object
 *       400:
 *         description: Fecha requerida
 *       500:
 *         description: Error interno del servidor
 */
router.get('/resumen', async (req, res) => {
  const { fecha } = req.query;

  if (!fecha) {
    return res.status(400).json({ error: 'Fecha requerida' });
  }

  try {
    const inicio = new Date(`${fecha}T00:00:00`);
    const fin = new Date(`${fecha}T23:59:59.999`);

    const filtro = {
      fecha: { $gte: inicio, $lte: fin },
      local: req.localId
    };
    if (req.userRole === 'cajero') {
      if (!req.userId) {
        return res.status(400).json({ error: 'Usuario requerido' });
      }
      filtro.usuario = req.userId;
    }

    const filtroWeb = {
      fecha: { $gte: inicio, $lte: fin },
      local: req.localId,
      estado_pedido: /^entregado$/i
    };

    const [ventasPos, ventasWeb] = await Promise.all([
      Venta.find(filtro),
      VentaCliente.find(filtroWeb)
    ]);
    const ventasConsolidadas = consolidarVentas(ventasPos, ventasWeb);

    const totalPos = ventasPos.reduce((acc, v) => acc + (Number(v.total) || 0), 0);
    const totalWeb = ventasWeb.reduce((acc, v) => acc + (Number(v.total) || 0), 0);
    const total = totalPos + totalWeb;
    const cantidadPos = ventasPos.length;
    const cantidadWeb = ventasWeb.length;
    const cantidad = cantidadPos + cantidadWeb;

    const { porTipoPago, porTipoPagoDetallado } = armarDesglosePorTipoPago(ventasConsolidadas);
    const porTipoProducto = await armarDesglosePorTipoProducto(ventasConsolidadas, req.localId);
    const porProducto = armarResumenPorProducto(ventasConsolidadas);

    res.json({
      total,
      cantidad,
      porTipoPago,
      porTipoPagoDetallado,
      porTipoProducto,
      porProducto,
      totalesPorCanal: {
        POS: { total: totalPos, cantidad: cantidadPos },
        WEB: { total: totalWeb, cantidad: cantidadWeb }
      }
    });
  } catch (err) {
    console.error('Error al obtener resumen:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/**
 * @swagger
 * /ventas/resumen-rango:
 *   get:
 *     summary: Obtener resumen de ventas por rango de fechas
 *     tags: [Ventas]
 *     parameters:
 *       - name: inicio
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *           example: "2024-07-01"
 *       - name: fin
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *           example: "2024-07-31"
 *     responses:
 *       200:
 *         description: Resumen con total, cantidad y pagos por tipo
 *       400:
 *         description: Fechas requeridas
 *       500:
 *         description: Error interno
 */
router.get('/resumen-rango', async (req, res) => {
  const { inicio, fin } = req.query;

  if (!inicio || !fin) {
    return res.status(400).json({ error: 'Se requieren las fechas de inicio y fin' });
  }

  try {
    const fechaInicio = new Date(`${inicio}T00:00:00`);
    const fechaFin = new Date(`${fin}T23:59:59.999`);

    const filtro = {
      fecha: { $gte: fechaInicio, $lte: fechaFin },
      local: req.localId
    };
    if (req.userRole === 'cajero') {
      if (!req.userId) {
        return res.status(400).json({ error: 'Usuario requerido' });
      }
      filtro.usuario = req.userId;
    }

    const filtroWeb = {
      fecha: { $gte: fechaInicio, $lte: fechaFin },
      local: req.localId,
      estado_pedido: /^entregado$/i
    };

    const [ventasPos, ventasWeb] = await Promise.all([
      Venta.find(filtro),
      VentaCliente.find(filtroWeb)
    ]);
    const ventasConsolidadas = consolidarVentas(ventasPos, ventasWeb);

    const totalPos = ventasPos.reduce((acc, v) => acc + (Number(v.total) || 0), 0);
    const totalWeb = ventasWeb.reduce((acc, v) => acc + (Number(v.total) || 0), 0);
    const total = totalPos + totalWeb;
    const cantidadPos = ventasPos.length;
    const cantidadWeb = ventasWeb.length;
    const cantidad = cantidadPos + cantidadWeb;

    const { porTipoPago, porTipoPagoDetallado } = armarDesglosePorTipoPago(ventasConsolidadas);
    const porTipoProducto = await armarDesglosePorTipoProducto(ventasConsolidadas, req.localId);
    const porProducto = armarResumenPorProducto(ventasConsolidadas);

    res.json({
      total,
      cantidad,
      porTipoPago,
      porTipoPagoDetallado,
      porTipoProducto,
      porProducto,
      totalesPorCanal: {
        POS: { total: totalPos, cantidad: cantidadPos },
        WEB: { total: totalWeb, cantidad: cantidadWeb }
      }
    });
  } catch (err) {
    console.error('Error al obtener resumen por rango:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/**
 * @swagger
 * /ventas:
 *   post:
 *     summary: Registrar una nueva venta
 *     tags: [Ventas]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               productos:
 *                 type: array
 *                 items:
 *                   type: object
 *               total:
 *                 type: number
 *               tipo_pago:
 *                 type: string
 *               tipo_pedido:
 *                 type: string
 *     responses:
 *       200:
 *         description: Venta registrada exitosamente
 *       500:
 *         description: Error al registrar venta
 */
router.post('/', async (req, res) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const { productos, total, tipo_pago, tipo_pedido, monto_recibido, vuelto } = req.body;
    const tipoPago = sanitizeText(tipo_pago, { max: 30 });
    const tipoPedido = sanitizeOptionalText(tipo_pedido, { max: 40 }) || '';

    if (!tipoPago) {
      const error = new Error('El tipo de pago es requerido.');
      error.status = 400;
      throw error;
    }

    if (!Array.isArray(productos) || productos.length === 0) {
      const error = new Error('La venta debe incluir al menos un producto.');
      error.status = 400;
      throw error;
    }

    const totalNumerico = Number(total);
    if (Number.isNaN(totalNumerico) || totalNumerico < 0) {
      const error = new Error('El total de la venta es inválido.');
      error.status = 400;
      throw error;
    }

    const montoRecibidoNumerico =
      monto_recibido === null || monto_recibido === undefined || monto_recibido === ''
        ? null
        : Number(monto_recibido);
    if (montoRecibidoNumerico !== null && (Number.isNaN(montoRecibidoNumerico) || montoRecibidoNumerico < 0)) {
      const error = new Error('El monto recibido es inválido.');
      error.status = 400;
      throw error;
    }

    const vueltoNumerico =
      vuelto === null || vuelto === undefined || vuelto === ''
        ? null
        : Number(vuelto);
    if (vueltoNumerico !== null && Number.isNaN(vueltoNumerico)) {
      const error = new Error('El vuelto es inválido.');
      error.status = 400;
      throw error;
    }

    const cajaAbierta = await Caja.findOne({
      cierre: null,
      local: req.localId
    }).session(session);
    if (!cajaAbierta) {
      const error = new Error('Debes abrir la caja antes de registrar ventas.');
      error.status = 400;
      throw error;
    }

    const productosRegistrados = [];

    for (const item of productos) {
      if (!item?.productoId) {
        const error = new Error('Cada producto debe incluir su identificador.');
        error.status = 400;
        throw error;
      }

      const cantidadSolicitada = Number(item.cantidad);
      if (!Number.isFinite(cantidadSolicitada) || cantidadSolicitada <= 0) {
        const error = new Error('La cantidad solicitada debe ser mayor que 0.');
        error.status = 400;
        throw error;
      }

      const producto = await ProductoLocal.findOne({
        _id: item.productoId,
        local: req.localId
      })
        .populate('productoBase')
        .session(session);
      if (!producto) {
        const error = new Error('Producto no encontrado.');
        error.status = 404;
        throw error;
      }

      const nombreProducto = producto.productoBase?.nombre || '';

      const usaVariantes = Array.isArray(producto.variantes) && producto.variantes.length > 0;
      let varianteSeleccionada = null;

      if (item.varianteId) {
        varianteSeleccionada = producto.variantes.id(item.varianteId);
        if (!varianteSeleccionada) {
          const error = new Error('La variante seleccionada no existe.');
          error.status = 404;
          throw error;
        }
      }

      if (usaVariantes) {
        if (!varianteSeleccionada) {
          const error = new Error(`Debes seleccionar una variante para ${nombreProducto}.`);
          error.status = 400;
          throw error;
        }

        if (varianteSeleccionada.stock < cantidadSolicitada) {
          const error = new Error(
            `Stock insuficiente para ${nombreProducto} (${varianteSeleccionada.nombre}). Disponible: ${varianteSeleccionada.stock}`
          );
          error.status = 400;
          throw error;
        }

        varianteSeleccionada.stock -= cantidadSolicitada;
        producto.stock = calcularStockDesdeVariantes(producto.variantes);
      } else {
        const controlaStock = typeof producto.stock === 'number' && !Number.isNaN(producto.stock);
        if (controlaStock) {
          if (producto.stock < cantidadSolicitada) {
            const error = new Error(`Stock insuficiente para ${nombreProducto}. Disponible: ${producto.stock}`);
            error.status = 400;
            throw error;
          }

          producto.stock -= cantidadSolicitada;
        }
      }

      await producto.save({ session });

      const precioUnitario =
        Number(
          item.precio_unitario ??
            (varianteSeleccionada && varianteSeleccionada.precio !== undefined
              ? varianteSeleccionada.precio
              : producto.precio)
        ) || 0;

      productosRegistrados.push({
        productoId: producto._id,
        nombre: nombreProducto || 'Producto sin nombre',
        precio_unitario: precioUnitario,
        cantidad: cantidadSolicitada,
        observacion: sanitizeOptionalText(item.observacion, { max: 120 }) || '',
        varianteId: varianteSeleccionada?._id || null,
        varianteNombre: item.varianteNombre || varianteSeleccionada?.nombre || null,
        atributos: obtenerAtributosVariante(varianteSeleccionada),
        agregados: normalizarAgregadosVenta(item.agregados)
      });
    }

    const venta = new Venta({
      productos: productosRegistrados,
      total: totalNumerico,
      tipo_pago: tipoPago,
      tipo_pedido: tipoPedido,
      monto_recibido: montoRecibidoNumerico,
      vuelto: vueltoNumerico,
      fecha: new Date(),
      numero_pedido: Math.floor(Math.random() * 100),
      local: req.localId,
      usuario: req.userId || null
    });

    await venta.save({ session });
    await session.commitTransaction();

    res.json({ mensaje: 'Venta registrada', numero_pedido: venta.numero_pedido });
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    console.error('Error al registrar venta:', err);
    res.status(err.status || 500).json({ error: err.message || 'Error interno al registrar venta' });
  } finally {
    session.endSession();
  }
});

module.exports = router;
