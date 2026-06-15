const express = require('express');
const mongoose = require('mongoose');
const Descuento = require('../models/descuento.model');
const { sanitizeText } = require('../utils/input');
const { adjuntarScopeLocal, requiereLocal } = require('../middlewares/localScope');
const { requiereRol } = require('../middlewares/roles');

const router = express.Router();
router.use(adjuntarScopeLocal);
router.use(requiereLocal);
router.use(requiereRol('superadmin', 'admin', 'cajero'));

const normalizarPayload = (body) => {
  const nombre = sanitizeText(body?.nombre, { max: 80 });
  const tipo = body?.tipo === 'fijo' ? 'fijo' : body?.tipo === 'porcentaje' ? 'porcentaje' : null;
  const valor = Number(body?.valor);
  if (!nombre) throw new Error('El nombre es obligatorio');
  if (!tipo) throw new Error('El tipo de descuento es invalido');
  if (!Number.isFinite(valor) || valor <= 0) throw new Error('El valor debe ser mayor que 0');
  if (tipo === 'porcentaje' && valor > 100) throw new Error('El porcentaje no puede superar 100');
  return { nombre, tipo, valor: Math.round(valor * 100) / 100 };
};

router.get('/', async (req, res) => {
  try {
    const filtro = { local: req.localId };
    if (String(req.query?.activos || '') === 'true') filtro.activo = true;
    const descuentos = await Descuento.find(filtro).sort({ activo: -1, nombre: 1 });
    res.json(descuentos);
  } catch {
    res.status(500).json({ error: 'No se pudieron cargar los descuentos' });
  }
});

router.post('/', requiereRol('superadmin', 'admin'), async (req, res) => {
  try {
    const payload = normalizarPayload(req.body);
    const descuento = await Descuento.create({
      ...payload,
      activo: req.body?.activo !== false,
      local: req.localId,
      creado_por: req.userId || null
    });
    res.status(201).json(descuento);
  } catch (error) {
    const mensaje = error?.code === 11000 ? 'Ya existe un descuento con ese nombre' : error.message;
    res.status(400).json({ error: mensaje || 'No se pudo crear el descuento' });
  }
});

router.put('/:id', requiereRol('superadmin', 'admin'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Descuento invalido' });
    const payload = normalizarPayload(req.body);
    const descuento = await Descuento.findOneAndUpdate(
      { _id: req.params.id, local: req.localId },
      { ...payload, activo: req.body?.activo !== false, actualizado_en: new Date() },
      { new: true, runValidators: true }
    );
    if (!descuento) return res.status(404).json({ error: 'Descuento no encontrado' });
    res.json(descuento);
  } catch (error) {
    const mensaje = error?.code === 11000 ? 'Ya existe un descuento con ese nombre' : error.message;
    res.status(400).json({ error: mensaje || 'No se pudo actualizar el descuento' });
  }
});

router.delete('/:id', requiereRol('superadmin', 'admin'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Descuento invalido' });
    const descuento = await Descuento.findOneAndDelete({ _id: req.params.id, local: req.localId });
    if (!descuento) return res.status(404).json({ error: 'Descuento no encontrado' });
    res.json({ mensaje: 'Descuento eliminado' });
  } catch {
    res.status(500).json({ error: 'No se pudo eliminar el descuento' });
  }
});

module.exports = router;
