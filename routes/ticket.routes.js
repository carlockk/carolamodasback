const express = require('express');
const Ticket = require('../models/ticket.model');
const {
  sanitizeText,
  sanitizeOptionalText,
  toNumberOrNull
} = require('../utils/input');
const { adjuntarScopeLocal, requiereLocal } = require('../middlewares/localScope');
const { requiereRol } = require('../middlewares/roles');

const router = express.Router();
router.use(adjuntarScopeLocal);
router.use(requiereLocal);
router.use(requiereRol('superadmin', 'admin', 'cajero'));

const normalizarAgregadosTicket = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((agg) => {
      const nombre = sanitizeOptionalText(agg?.nombre, { max: 80 }) || '';
      if (!nombre) return null;
      const precio = Number(agg?.precio);
      return {
        agregadoId: agg?.agregadoId || null,
        nombre,
        precio: Number.isFinite(precio) && precio > 0 ? precio : 0
      };
    })
    .filter(Boolean);
};

/**
 * @swagger
 * tags:
 *   name: Tickets
 *   description: Gestión de tickets emitidos
 */

/**
 * @swagger
 * /tickets:
 *   post:
 *     summary: Crear un nuevo ticket
 *     tags: [Tickets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nombre
 *               - productos
 *               - total
 *             properties:
 *               nombre:
 *                 type: string
 *                 example: "Mesa 4"
 *               total:
 *                 type: number
 *                 example: 123.45
 *               productos:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     productoId:
 *                       type: string
 *                       example: "60d...abc"
 *                     nombre:
 *                       type: string
 *                       example: "Coca Cola"
 *                     precio_unitario:
 *                       type: number
 *                       example: 1500
 *                     cantidad:
 *                       type: integer
 *                       example: 2
 *                     observacion:
 *                       type: string
 *                       example: "Sin hielo"
 *     responses:
 *       201:
 *         description: Ticket guardado
 *       400:
 *         description: Datos incompletos
 *       500:
 *         description: Error al guardar ticket
 */
router.post('/', async (req, res) => {
  const nombre = sanitizeText(req.body.nombre, { max: 80 });
  const productos = Array.isArray(req.body.productos) ? req.body.productos : null;
  const total = toNumberOrNull(req.body.total);

  if (!nombre || !productos || total === null) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const productosLimpios = productos.map((item) => ({
      ...item,
      productoBaseId: item?.productoBaseId || null,
      nombre: sanitizeOptionalText(item?.nombre, { max: 120 }) || '',
      observacion: sanitizeOptionalText(item?.observacion, { max: 120 }) || '',
      varianteNombre: sanitizeOptionalText(item?.varianteNombre, { max: 80 }) || '',
      agregados: normalizarAgregadosTicket(item?.agregados),
      precio_original: Number(item?.precio_original ?? item?.precio_unitario) || 0,
      descuento: item?.descuento && typeof item.descuento === 'object' ? item.descuento : null
    }));

    const nuevo = new Ticket({
      nombre,
      productos: productosLimpios,
      total,
      subtotal: Number(req.body?.subtotal) || total,
      descuento_total: Number(req.body?.descuento_total) || 0,
      descuento_venta: req.body?.descuento_venta && typeof req.body.descuento_venta === 'object'
        ? req.body.descuento_venta
        : null,
      local: req.localId,
      usuario: req.userId || null
    });
    await nuevo.save();
    res.status(201).json({ mensaje: 'Ticket guardado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar ticket' });
  }
});

/**
 * @swagger
 * /tickets:
 *   get:
 *     summary: Obtener todos los tickets
 *     tags: [Tickets]
 *     responses:
 *       200:
 *         description: Lista de tickets
 *       500:
 *         description: Error al obtener tickets
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

    const tickets = await Ticket.find(filtro).sort({ creado: -1 });
    res.json(tickets);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener tickets' });
  }
});

/**
 * @swagger
 * /tickets/{id}:
 *   delete:
 *     summary: Eliminar un ticket por ID
 *     tags: [Tickets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: ID del ticket a eliminar
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Ticket eliminado
 *       500:
 *         description: Error al eliminar ticket
 */
router.delete('/:id', async (req, res) => {
  try {
    await Ticket.findOneAndDelete({ _id: req.params.id, local: req.localId });
    res.json({ mensaje: 'Ticket eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar ticket' });
  }
});

module.exports = router;
