const express = require('express');
const Caja = require('../models/caja.model.js');
const Venta = require('../models/venta.model.js');
const Devolucion = require('../models/devolucion.model.js');
const { sanitizeOptionalText } = require('../utils/input');
const { adjuntarScopeLocal, requiereLocal } = require('../middlewares/localScope');
const { requiereRol } = require('../middlewares/roles');

const router = express.Router();
router.use(adjuntarScopeLocal);
router.use(requiereLocal);
router.use(requiereRol('superadmin', 'admin', 'cajero'));

/**
 * @swagger
 * tags:
 *   name: Caja
 *   description: Gestión de apertura y cierre de caja
 */

/**
 * @swagger
 * /caja/abrir:
 *   post:
 *     summary: Abrir una nueva caja
 *     tags: [Caja]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               monto_inicial:
 *                 type: number
 *                 example: 10000
 *     responses:
 *       200:
 *         description: Caja abierta exitosamente
 *       400:
 *         description: Error por monto inválido o caja ya abierta
 *       500:
 *         description: Error del servidor
 */
router.post('/abrir', async (req, res) => {
  try {
    const monto = parseFloat(req.body.monto_inicial);
    if (isNaN(monto) || monto <= 0) {
      return res.status(400).json({ error: 'Monto inicial inválido' });
    }

    const caja_abierta = await Caja.findOne({ cierre: null, local: req.localId });
    if (caja_abierta) {
      return res.status(400).json({ error: 'Ya hay una caja abierta.' });
    }

    const nueva = new Caja({ monto_inicial: monto, local: req.localId });
    await nueva.save();

    res.json({ mensaje: 'Caja abierta', id: nueva._id });
  } catch (error) {
    console.error('Error al abrir caja:', error);
    res.status(500).json({ error: 'Error del servidor al abrir la caja' });
  }
});

/**
 * @swagger
 * /caja/cerrar:
 *   post:
 *     summary: Cerrar la caja abierta actual
 *     tags: [Caja]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nombre:
 *                 type: string
 *                 example: Carlos
 *     responses:
 *       200:
 *         description: Caja cerrada con resumen
 *       400:
 *         description: No hay caja abierta
 *       500:
 *         description: Error al cerrar caja
 */
router.post('/cerrar', async (req, res) => {
  try {
    const caja = await Caja.findOne({ cierre: null, local: req.localId });
    if (!caja) return res.status(400).json({ error: 'No hay caja abierta.' });

    const cierre = new Date();
    const [ventas, devoluciones] = await Promise.all([
      Venta.find({ fecha: { $gte: caja.apertura, $lte: cierre }, local: req.localId }),
      Devolucion.find({ fecha: { $gte: caja.apertura, $lte: cierre }, local: req.localId })
        .populate('venta', 'numero_pedido')
        .populate('usuario', 'nombre email')
        .sort({ fecha: 1 })
    ]);
    const total_vendido = ventas.reduce((sum, v) => sum + v.total, 0);
    const total_devoluciones = devoluciones.reduce((sum, d) => sum + (Number(d.monto) || 0), 0);
    const total_neto = total_vendido - total_devoluciones;

    const desglose = {};
    ventas.forEach(v => {
      const pagos = Array.isArray(v.pagos) && v.pagos.length > 0
        ? v.pagos
        : [{ tipo: v.tipo_pago || 'Otro', monto: v.total }];

      pagos.forEach((pago) => {
        const metodo = pago.tipo || 'Otro';
        const monto = Number(pago.monto) || 0;
        if (monto <= 0) return;
        desglose[metodo] = (desglose[metodo] || 0) + monto;
      });
    });

    const desgloseDevoluciones = {};
    devoluciones.forEach((devolucion) => {
      const metodo = devolucion.tipo_pago || 'Otro';
      const monto = Number(devolucion.monto) || 0;
      if (monto <= 0) return;
      desgloseDevoluciones[metodo] = (desgloseDevoluciones[metodo] || 0) + monto;
      desglose[metodo] = (desglose[metodo] || 0) - monto;
    });

    caja.cierre = cierre;
    caja.monto_total_vendido = total_vendido;
    caja.monto_total_devoluciones = total_devoluciones;
    caja.monto_total_neto = total_neto;
    caja.monto_total_final = caja.monto_inicial + total_neto;
    caja.desglose_por_pago = desglose;
    caja.desglose_devoluciones_por_pago = desgloseDevoluciones;
    caja.devoluciones = devoluciones.map((devolucion) => ({
      venta_id: devolucion.venta?._id || devolucion.venta,
      numero_pedido: devolucion.venta?.numero_pedido || null,
      fecha: devolucion.fecha,
      monto: devolucion.monto,
      motivo: devolucion.motivo,
      tipo_pago: devolucion.tipo_pago,
      usuario: devolucion.usuario?.nombre || devolucion.usuario?.email || 'No identificado'
    }));

    const usuario = sanitizeOptionalText(req.body?.nombre, { max: 80 });
    caja.usuario = usuario || 'No identificado';
    await caja.save();

    res.json({
      mensaje: 'Caja cerrada',
      resumen: {
        apertura: caja.apertura,
        cierre: caja.cierre,
        monto_inicial: caja.monto_inicial,
        vendido: total_vendido,
        devoluciones: total_devoluciones,
        total_neto,
        total: caja.monto_total_final,
        usuario: caja.usuario,
        desglose_por_pago: desglose,
        desglose_devoluciones_por_pago: desgloseDevoluciones,
        detalle_devoluciones: caja.devoluciones
      }
    });
  } catch (error) {
    console.error("❌ Error al cerrar caja:", error);
    res.status(500).json({ error: 'Error del servidor al cerrar la caja' });
  }
});

/**
 * @swagger
 * /caja/historial:
 *   get:
 *     summary: Obtener historial de todas las cajas
 *     tags: [Caja]
 *     responses:
 *       200:
 *         description: Lista de cajas obtenida exitosamente
 *       500:
 *         description: Error al obtener historial
 */
router.get('/historial', async (_req, res) => {
  try {
    const cajas = await Caja.find({ local: _req.localId }).sort({ apertura: -1 });
    res.json(cajas);
  } catch (error) {
    console.error('Error en historial:', error);
    res.status(500).json({ error: 'No se pudo cargar el historial de cajas' });
  }
});

module.exports = router;
