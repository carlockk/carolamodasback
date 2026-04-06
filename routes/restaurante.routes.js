const express = require('express');
const mongoose = require('mongoose');
const RestauranteMesa = require('../models/restauranteMesa.model');
const RestauranteComanda = require('../models/restauranteComanda.model');
const ProductoLocal = require('../models/productLocal.model');
const Caja = require('../models/caja.model');
const Venta = require('../models/venta.model');
const Usuario = require('../models/usuario.model');
const { sanitizeText, sanitizeOptionalText } = require('../utils/input');
const { adjuntarScopeLocal, requiereLocal } = require('../middlewares/localScope');

const router = express.Router();
router.use(adjuntarScopeLocal);
router.use(requiereLocal);

const ESTADOS_MESA = new Set(['libre', 'ocupada', 'reservada', 'inactiva']);
const ESTADOS_COMANDA = new Set([
  'abierta',
  'en_preparacion',
  'lista',
  'entregada',
  'lista_para_cobro',
  'cerrada',
  'cancelada'
]);

const esObjectIdValido = (id) => mongoose.Types.ObjectId.isValid(id);
const esAdmin = (rol) => rol === 'admin' || rol === 'superadmin';
const esCobrador = (rol) => rol === 'admin' || rol === 'superadmin' || rol === 'cajero';
const esMeseroOCobrador = (rol) => rol === 'mesero' || esCobrador(rol);
const esAdminOCajero = (rol) => esAdmin(rol) || rol === 'cajero';

const normalizarItemsComanda = async (itemsRaw, localId) => {
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    throw new Error('Debes agregar al menos un item');
  }

  const items = [];
  for (const item of itemsRaw) {
    const productoId = item?.productoId;
    const cantidad = Number(item?.cantidad);
    const nota = sanitizeOptionalText(item?.nota, { max: 140 }) || '';

    if (!productoId || !esObjectIdValido(productoId)) {
      throw new Error('Item con producto invalido');
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw new Error('Item con cantidad invalida');
    }

    const producto = await ProductoLocal.findOne({ _id: productoId, local: localId })
      .populate('productoBase')
      .lean();
    if (!producto) {
      throw new Error('Producto no encontrado en este local');
    }

    const nombre = sanitizeText(producto.productoBase?.nombre, { max: 120 }) || 'Producto';
    const precioUnitario = Number(producto.precio);
    if (!Number.isFinite(precioUnitario) || precioUnitario < 0) {
      throw new Error(`Producto con precio invalido: ${nombre}`);
    }

    items.push({
      productoId: producto._id,
      nombre,
      precio_unitario: precioUnitario,
      cantidad,
      nota,
      subtotal: precioUnitario * cantidad
    });
  }

  return items;
};

const cerrarMesaSiCorresponde = async (localId, mesaId, comandaIdExcluida) => {
  if (!mesaId) return;
  const abierta = await RestauranteComanda.exists({
    _id: { $ne: comandaIdExcluida },
    local: localId,
    mesa: mesaId,
    estado: { $in: ['abierta', 'en_preparacion', 'lista', 'entregada', 'lista_para_cobro'] }
  });
  if (!abierta) {
    await RestauranteMesa.updateOne(
      { _id: mesaId, local: localId },
      { $set: { estado: 'libre', meseroAsignado: null, asignadaEn: null } }
    );
  }
};

const puedeOperarMesa = (req, mesa) => {
  if (!mesa) return false;
  if (esAdminOCajero(req.userRole)) return true;
  if (req.userRole !== 'mesero') return false;
  return Boolean(req.userId && mesa.meseroAsignado && String(mesa.meseroAsignado) === String(req.userId));
};

router.get('/productos', async (req, res) => {
  try {
    const productos = await ProductoLocal.find({ local: req.localId, activo: true })
      .populate('productoBase', 'nombre')
      .sort({ createdAt: -1 })
      .lean();

    const respuesta = productos.map((producto) => ({
      _id: producto._id,
      nombre: sanitizeText(producto?.productoBase?.nombre, { max: 120 }) || 'Producto',
      precio: Number(producto?.precio) || 0
    }));

    res.json(respuesta);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos para restaurante' });
  }
});

router.get('/mesas', async (req, res) => {
  try {
    const soloActivas = String(req.query.activas || 'true') !== 'false';
    const filtro = { local: req.localId };
    if (soloActivas) filtro.activa = true;

    const mesas = await RestauranteMesa.find(filtro)
      .populate('meseroAsignado', 'nombre email rol')
      .sort({ numero: 1 });
    res.json(mesas);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener mesas' });
  }
});

router.get('/meseros', async (req, res) => {
  try {
    if (!esAdminOCajero(req.userRole)) {
      return res.status(403).json({ error: 'No tienes permisos para ver meseros' });
    }
    const meseros = await Usuario.find(
      { local: req.localId, rol: 'mesero' },
      'nombre email rol'
    ).sort({ nombre: 1 });
    res.json(meseros);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener meseros' });
  }
});

router.post('/mesas', async (req, res) => {
  try {
    const numero = Number(req.body.numero);
    if (!Number.isFinite(numero) || numero <= 0) {
      return res.status(400).json({ error: 'Numero de mesa invalido' });
    }

    const payload = {
      local: req.localId,
      numero,
      nombre: sanitizeOptionalText(req.body.nombre, { max: 80 }) || '',
      zona: sanitizeOptionalText(req.body.zona, { max: 80 }) || '',
      capacidad: Number(req.body.capacidad) || 4,
      estado: 'libre',
      activa: true
    };

    const nueva = await RestauranteMesa.create(payload);
    res.status(201).json(nueva);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ error: 'Ya existe una mesa con ese numero' });
    }
    res.status(500).json({ error: 'Error al crear mesa' });
  }
});

router.patch('/mesas/:id/estado', async (req, res) => {
  try {
    const estado = sanitizeText(req.body.estado, { max: 30 });
    if (!estado || !ESTADOS_MESA.has(estado)) {
      return res.status(400).json({ error: 'Estado de mesa invalido' });
    }

    const mesa = await RestauranteMesa.findOne({ _id: req.params.id, local: req.localId });
    if (!mesa) {
      return res.status(404).json({ error: 'Mesa no encontrada' });
    }
    if (!puedeOperarMesa(req, mesa)) {
      return res.status(403).json({ error: 'No tienes permisos para operar esta mesa' });
    }

    mesa.estado = estado;
    if (estado === 'inactiva') {
      mesa.activa = false;
    }
    if (estado === 'libre') {
      mesa.meseroAsignado = null;
      mesa.asignadaEn = null;
    }
    await mesa.save();

    res.json(mesa);
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar estado de mesa' });
  }
});

router.post('/mesas/:id/tomar', async (req, res) => {
  try {
    if (req.userRole !== 'mesero') {
      return res.status(403).json({ error: 'Solo un mesero puede tomar una mesa' });
    }
    if (!req.userId) {
      return res.status(400).json({ error: 'Usuario requerido' });
    }

    const mesa = await RestauranteMesa.findOne({ _id: req.params.id, local: req.localId, activa: true });
    if (!mesa) {
      return res.status(404).json({ error: 'Mesa no encontrada' });
    }
    if (mesa.estado === 'inactiva') {
      return res.status(400).json({ error: 'La mesa esta inactiva' });
    }
    if (mesa.estado !== 'libre') {
      return res.status(400).json({ error: 'Solo se puede tomar una mesa libre' });
    }
    if (mesa.meseroAsignado && String(mesa.meseroAsignado) !== String(req.userId)) {
      return res.status(400).json({ error: 'La mesa ya esta asignada a otro mesero' });
    }

    mesa.meseroAsignado = req.userId;
    mesa.asignadaEn = new Date();
    await mesa.save();

    const poblada = await RestauranteMesa.findById(mesa._id).populate('meseroAsignado', 'nombre email rol');
    res.json(poblada);
  } catch (error) {
    res.status(500).json({ error: 'Error al tomar mesa' });
  }
});

router.post('/mesas/:id/liberar', async (req, res) => {
  try {
    const mesa = await RestauranteMesa.findOne({ _id: req.params.id, local: req.localId });
    if (!mesa) {
      return res.status(404).json({ error: 'Mesa no encontrada' });
    }
    if (!puedeOperarMesa(req, mesa)) {
      return res.status(403).json({ error: 'No tienes permisos para liberar esta mesa' });
    }

    const activa = await RestauranteComanda.exists({
      local: req.localId,
      mesa: mesa._id,
      estado: { $in: ['abierta', 'en_preparacion', 'lista', 'entregada', 'lista_para_cobro'] }
    });
    if (activa) {
      return res.status(400).json({ error: 'No se puede liberar la mesa con comandas activas' });
    }

    mesa.estado = 'libre';
    mesa.meseroAsignado = null;
    mesa.asignadaEn = null;
    await mesa.save();

    const poblada = await RestauranteMesa.findById(mesa._id).populate('meseroAsignado', 'nombre email rol');
    res.json(poblada);
  } catch (error) {
    res.status(500).json({ error: 'Error al liberar mesa' });
  }
});

router.post('/mesas/:id/transferir', async (req, res) => {
  try {
    if (!esAdminOCajero(req.userRole)) {
      return res.status(403).json({ error: 'Solo admin o cajero puede transferir mesa' });
    }
    const meseroId = req.body?.meseroId;
    if (!meseroId || !esObjectIdValido(meseroId)) {
      return res.status(400).json({ error: 'Mesero invalido' });
    }

    const mesa = await RestauranteMesa.findOne({ _id: req.params.id, local: req.localId });
    if (!mesa) {
      return res.status(404).json({ error: 'Mesa no encontrada' });
    }
    if (mesa.estado === 'inactiva') {
      return res.status(400).json({ error: 'La mesa esta inactiva' });
    }

    const mesero = await Usuario.findOne({ _id: meseroId, local: req.localId, rol: 'mesero' });
    if (!mesero) {
      return res.status(400).json({ error: 'Mesero no encontrado en este local' });
    }

    mesa.meseroAsignado = mesero._id;
    if (!mesa.asignadaEn) mesa.asignadaEn = new Date();
    if (mesa.estado === 'libre') mesa.estado = 'ocupada';
    await mesa.save();

    const poblada = await RestauranteMesa.findById(mesa._id).populate('meseroAsignado', 'nombre email rol');
    res.json(poblada);
  } catch (error) {
    res.status(500).json({ error: 'Error al transferir mesa' });
  }
});

router.put('/mesas/:id', async (req, res) => {
  try {
    if (!esAdminOCajero(req.userRole)) {
      return res.status(403).json({ error: 'Solo admin o cajero puede editar mesas' });
    }

    const mesa = await RestauranteMesa.findOne({ _id: req.params.id, local: req.localId });
    if (!mesa) {
      return res.status(404).json({ error: 'Mesa no encontrada' });
    }

    if (req.body?.numero !== undefined) {
      const numero = Number(req.body.numero);
      if (!Number.isFinite(numero) || numero <= 0) {
        return res.status(400).json({ error: 'Numero de mesa invalido' });
      }
      mesa.numero = numero;
    }

    if (req.body?.nombre !== undefined) {
      mesa.nombre = sanitizeOptionalText(req.body.nombre, { max: 80 }) || '';
    }

    if (req.body?.zona !== undefined) {
      mesa.zona = sanitizeOptionalText(req.body.zona, { max: 80 }) || '';
    }

    if (req.body?.capacidad !== undefined) {
      const capacidad = Number(req.body.capacidad);
      if (!Number.isFinite(capacidad) || capacidad <= 0) {
        return res.status(400).json({ error: 'Capacidad invalida' });
      }
      mesa.capacidad = capacidad;
    }

    if (req.body?.estado !== undefined) {
      const estado = sanitizeText(req.body.estado, { max: 30 });
      if (!estado || !ESTADOS_MESA.has(estado)) {
        return res.status(400).json({ error: 'Estado de mesa invalido' });
      }
      mesa.estado = estado;
      mesa.activa = estado !== 'inactiva';
      if (estado === 'libre') {
        mesa.meseroAsignado = null;
        mesa.asignadaEn = null;
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'meseroAsignado')) {
      const meseroId = req.body.meseroAsignado;
      if (meseroId === null || String(meseroId).trim() === '') {
        mesa.meseroAsignado = null;
        mesa.asignadaEn = null;
      } else {
        if (!esObjectIdValido(meseroId)) {
          return res.status(400).json({ error: 'Mesero invalido' });
        }
        const mesero = await Usuario.findOne({ _id: meseroId, local: req.localId, rol: 'mesero' });
        if (!mesero) {
          return res.status(400).json({ error: 'Mesero no encontrado en este local' });
        }
        mesa.meseroAsignado = mesero._id;
        if (!mesa.asignadaEn) mesa.asignadaEn = new Date();
        if (mesa.estado === 'libre') mesa.estado = 'ocupada';
      }
    }

    await mesa.save();
    res.json(mesa);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ error: 'Ya existe una mesa con ese numero' });
    }
    res.status(400).json({ error: error.message || 'Error al editar mesa' });
  }
});

router.delete('/mesas/:id', async (req, res) => {
  try {
    if (!esAdmin(req.userRole)) {
      return res.status(403).json({ error: 'Solo admin puede eliminar mesas' });
    }

    const mesa = await RestauranteMesa.findOne({ _id: req.params.id, local: req.localId });
    if (!mesa) {
      return res.status(404).json({ error: 'Mesa no encontrada' });
    }

    const comandaActiva = await RestauranteComanda.exists({
      local: req.localId,
      mesa: mesa._id,
      estado: { $in: ['abierta', 'en_preparacion', 'lista', 'entregada', 'lista_para_cobro'] }
    });
    if (comandaActiva) {
      return res.status(400).json({
        error: 'No se puede eliminar la mesa porque tiene comandas activas'
      });
    }

    await mesa.deleteOne();
    res.json({ mensaje: 'Mesa eliminada correctamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar mesa' });
  }
});

router.get('/comandas', async (req, res) => {
  try {
    const estado = sanitizeOptionalText(req.query.estado, { max: 40 });
    const mesaId = req.query.mesaId;

    const filtro = { local: req.localId };
    if (req.userRole === 'mesero') {
      if (!req.userId) {
        return res.status(400).json({ error: 'Usuario requerido' });
      }
      filtro.mesero = req.userId;
    }
    if (estado && ESTADOS_COMANDA.has(estado)) {
      filtro.estado = estado;
    }
    if (mesaId && esObjectIdValido(mesaId)) {
      filtro.mesa = mesaId;
    }

    const comandas = await RestauranteComanda.find(filtro)
      .populate('mesa', 'numero nombre zona estado')
      .populate('mesero', 'nombre email rol')
      .sort({ createdAt: -1 });

    res.json(comandas);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener comandas' });
  }
});

router.post('/comandas', async (req, res) => {
  try {
    const mesaId = req.body.mesaId;
    if (!mesaId || !esObjectIdValido(mesaId)) {
      return res.status(400).json({ error: 'Mesa invalida' });
    }

    const mesa = await RestauranteMesa.findOne({ _id: mesaId, local: req.localId, activa: true });
    if (!mesa) {
      return res.status(404).json({ error: 'Mesa no encontrada' });
    }
    if (mesa.estado === 'inactiva') {
      return res.status(400).json({ error: 'La mesa esta inactiva' });
    }
    if (req.userRole === 'mesero') {
      if (!mesa.meseroAsignado || String(mesa.meseroAsignado) !== String(req.userId || '')) {
        return res.status(403).json({ error: 'Debes tomar la mesa antes de crear la comanda' });
      }
    }

    const items = await normalizarItemsComanda(req.body.items, req.localId);
    const observacion = sanitizeOptionalText(req.body.observacion, { max: 200 }) || '';

    const comanda = new RestauranteComanda({
      local: req.localId,
      mesa: mesa._id,
      mesero: req.userId || null,
      estado: 'abierta',
      observacion,
      items
    });

    await comanda.save();

    if (mesa.estado === 'libre') {
      mesa.estado = 'ocupada';
      await mesa.save();
    }

    const poblada = await RestauranteComanda.findById(comanda._id)
      .populate('mesa', 'numero nombre zona estado')
      .populate('mesero', 'nombre email rol');

    res.status(201).json(poblada);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Error al crear comanda' });
  }
});

router.post('/comandas/:id/items', async (req, res) => {
  try {
    const comanda = await RestauranteComanda.findOne({ _id: req.params.id, local: req.localId });
    if (!comanda) {
      return res.status(404).json({ error: 'Comanda no encontrada' });
    }
    if (comanda.estado === 'cerrada' || comanda.estado === 'cancelada' || comanda.estado === 'lista_para_cobro') {
      return res.status(400).json({ error: 'No se pueden agregar items a una comanda cerrada o enviada a caja' });
    }
    if (req.userRole === 'mesero' && String(comanda.mesero || '') !== String(req.userId || '')) {
      return res.status(403).json({ error: 'No puedes modificar comandas de otro mesero' });
    }

    const nuevosItems = await normalizarItemsComanda(req.body.items, req.localId);
    comanda.items.push(...nuevosItems);
    await comanda.save();

    const poblada = await RestauranteComanda.findById(comanda._id)
      .populate('mesa', 'numero nombre zona estado')
      .populate('mesero', 'nombre email rol');

    res.json(poblada);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Error al agregar items' });
  }
});

router.patch('/comandas/:id/estado', async (req, res) => {
  try {
    const estado = sanitizeText(req.body.estado, { max: 40 });
    if (!estado || !ESTADOS_COMANDA.has(estado)) {
      return res.status(400).json({ error: 'Estado de comanda invalido' });
    }

    const comanda = await RestauranteComanda.findOne({ _id: req.params.id, local: req.localId });
    if (!comanda) {
      return res.status(404).json({ error: 'Comanda no encontrada' });
    }
    if (req.userRole === 'mesero' && String(comanda.mesero || '') !== String(req.userId || '')) {
      return res.status(403).json({ error: 'No puedes cambiar el estado de comandas de otro mesero' });
    }

    comanda.estado = estado;
    if (estado === 'cerrada' || estado === 'cancelada') {
      comanda.cerradaEn = new Date();
    }
    await comanda.save();

    const mesa = await RestauranteMesa.findOne({ _id: comanda.mesa, local: req.localId });
    if (mesa) {
      if (estado === 'cerrada' || estado === 'cancelada') {
        const abierta = await RestauranteComanda.exists({
          _id: { $ne: comanda._id },
          local: req.localId,
          mesa: mesa._id,
          estado: { $in: ['abierta', 'en_preparacion', 'lista', 'entregada', 'lista_para_cobro'] }
        });
        if (!abierta) {
          mesa.estado = 'libre';
          await mesa.save();
        }
      } else if (mesa.estado === 'libre') {
        mesa.estado = 'ocupada';
        await mesa.save();
      }
    }

    const poblada = await RestauranteComanda.findById(comanda._id)
      .populate('mesa', 'numero nombre zona estado')
      .populate('mesero', 'nombre email rol');

    res.json(poblada);
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar estado de comanda' });
  }
});

router.put('/comandas/:id', async (req, res) => {
  try {
    if (!esAdmin(req.userRole)) {
      return res.status(403).json({ error: 'Solo admin puede editar comandas' });
    }

    const comanda = await RestauranteComanda.findOne({ _id: req.params.id, local: req.localId });
    if (!comanda) {
      return res.status(404).json({ error: 'Comanda no encontrada' });
    }
    if (comanda.estado === 'cerrada' || comanda.estado === 'cancelada') {
      return res.status(400).json({ error: 'No se puede editar una comanda cerrada' });
    }

    const mesaId = req.body?.mesaId;
    if (mesaId !== undefined) {
      if (!mesaId || !esObjectIdValido(mesaId)) {
        return res.status(400).json({ error: 'Mesa invalida' });
      }
      const mesaDestino = await RestauranteMesa.findOne({
        _id: mesaId,
        local: req.localId,
        activa: true
      });
      if (!mesaDestino || mesaDestino.estado === 'inactiva') {
        return res.status(400).json({ error: 'Mesa destino invalida' });
      }

      const mesaAnteriorId = String(comanda.mesa);
      comanda.mesa = mesaDestino._id;
      if (mesaDestino.estado === 'libre') {
        mesaDestino.estado = 'ocupada';
        await mesaDestino.save();
      }

      if (mesaAnteriorId !== String(mesaDestino._id)) {
        const abiertaEnAnterior = await RestauranteComanda.exists({
          _id: { $ne: comanda._id },
          local: req.localId,
          mesa: mesaAnteriorId,
          estado: { $in: ['abierta', 'en_preparacion', 'lista', 'entregada', 'lista_para_cobro'] }
        });
        if (!abiertaEnAnterior) {
          await RestauranteMesa.updateOne(
            { _id: mesaAnteriorId, local: req.localId },
            { $set: { estado: 'libre' } }
          );
        }
      }
    }

    if (req.body?.observacion !== undefined) {
      comanda.observacion = sanitizeOptionalText(req.body.observacion, { max: 200 }) || '';
    }

    if (req.body?.estado !== undefined) {
      const estado = sanitizeText(req.body.estado, { max: 40 });
      if (!estado || !ESTADOS_COMANDA.has(estado)) {
        return res.status(400).json({ error: 'Estado de comanda invalido' });
      }
      comanda.estado = estado;
      if (estado === 'cerrada' || estado === 'cancelada') {
        comanda.cerradaEn = new Date();
      }
    }

    if (req.body?.items !== undefined) {
      const nuevosItems = await normalizarItemsComanda(req.body.items, req.localId);
      comanda.items = nuevosItems;
    }

    await comanda.save();

    const poblada = await RestauranteComanda.findById(comanda._id)
      .populate('mesa', 'numero nombre zona estado')
      .populate('mesero', 'nombre email rol');

    res.json(poblada);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Error al editar comanda' });
  }
});

router.delete('/comandas/:id', async (req, res) => {
  try {
    if (!esAdmin(req.userRole)) {
      return res.status(403).json({ error: 'Solo admin puede eliminar comandas' });
    }

    const comanda = await RestauranteComanda.findOne({ _id: req.params.id, local: req.localId });
    if (!comanda) {
      return res.status(404).json({ error: 'Comanda no encontrada' });
    }

    const mesaId = String(comanda.mesa);
    await comanda.deleteOne();

    const abierta = await RestauranteComanda.exists({
      local: req.localId,
      mesa: mesaId,
      estado: { $in: ['abierta', 'en_preparacion', 'lista', 'entregada', 'lista_para_cobro'] }
    });
    if (!abierta) {
      await RestauranteMesa.updateOne({ _id: mesaId, local: req.localId }, { $set: { estado: 'libre' } });
    }

    res.json({ mensaje: 'Comanda eliminada correctamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar comanda' });
  }
});

router.post('/comandas/:id/enviar-caja', async (req, res) => {
  try {
    const comanda = await RestauranteComanda.findOne({ _id: req.params.id, local: req.localId })
      .populate('mesa', 'numero nombre estado');
    if (!comanda) {
      return res.status(404).json({ error: 'Comanda no encontrada' });
    }
    if (req.userRole === 'mesero' && String(comanda.mesero || '') !== String(req.userId || '')) {
      return res.status(403).json({ error: 'No puedes enviar a caja comandas de otro mesero' });
    }
    if (comanda.estado === 'cerrada' || comanda.estado === 'cancelada') {
      return res.status(400).json({ error: 'La comanda ya esta cerrada o cancelada' });
    }
    if (!Array.isArray(comanda.items) || comanda.items.length === 0) {
      return res.status(400).json({ error: 'La comanda no tiene items para cobrar' });
    }

    comanda.estado = 'lista_para_cobro';
    await comanda.save();

    const poblada = await RestauranteComanda.findById(comanda._id)
      .populate('mesa', 'numero nombre zona estado')
      .populate('mesero', 'nombre email rol');

    res.json(poblada);
  } catch (error) {
    res.status(500).json({ error: 'Error al enviar comanda a caja' });
  }
});

router.get('/caja/pendientes', async (req, res) => {
  try {
    if (!esCobrador(req.userRole)) {
      return res.status(403).json({ error: 'No tienes permisos para ver pendientes de caja' });
    }

    const pendientes = await RestauranteComanda.find({
      local: req.localId,
      estado: 'lista_para_cobro'
    })
      .populate('mesa', 'numero nombre zona estado')
      .populate('mesero', 'nombre email rol')
      .sort({ updatedAt: 1 });

    res.json(pendientes);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener comandas pendientes de caja' });
  }
});

router.post('/caja/cobrar/:id', async (req, res) => {
  try {
    if (!esCobrador(req.userRole)) {
      return res.status(403).json({ error: 'No tienes permisos para cobrar comandas' });
    }

    const tipoPago = sanitizeText(req.body?.tipo_pago, { max: 30 });
    const tipoPedidoInput = sanitizeOptionalText(req.body?.tipo_pedido, { max: 40 }) || '';
    const montoRecibidoInput = req.body?.monto_recibido;
    const vueltoInput = req.body?.vuelto;
    if (!tipoPago) {
      return res.status(400).json({ error: 'Tipo de pago requerido' });
    }

    const montoRecibido =
      montoRecibidoInput === null || montoRecibidoInput === undefined || montoRecibidoInput === ''
        ? null
        : Number(montoRecibidoInput);
    if (montoRecibido !== null && (Number.isNaN(montoRecibido) || montoRecibido < 0)) {
      return res.status(400).json({ error: 'Monto recibido invalido' });
    }

    const vuelto =
      vueltoInput === null || vueltoInput === undefined || vueltoInput === ''
        ? null
        : Number(vueltoInput);
    if (vuelto !== null && Number.isNaN(vuelto)) {
      return res.status(400).json({ error: 'Vuelto invalido' });
    }

    const cajaAbierta = await Caja.findOne({ cierre: null, local: req.localId });
    if (!cajaAbierta) {
      return res.status(400).json({ error: 'Debes abrir la caja antes de cobrar' });
    }

    const comanda = await RestauranteComanda.findOne({
      _id: req.params.id,
      local: req.localId
    }).populate('mesa', 'numero nombre estado');

    if (!comanda) {
      return res.status(404).json({ error: 'Comanda no encontrada' });
    }
    if (comanda.estado !== 'lista_para_cobro') {
      return res.status(400).json({ error: 'La comanda no esta lista para cobro' });
    }

    const itemsVenta = (comanda.items || []).map((item) => ({
      productoId: item.productoId,
      nombre: item.nombre,
      precio_unitario: Number(item.precio_unitario) || 0,
      cantidad: Number(item.cantidad) || 0,
      observacion: item.nota || '',
      varianteId: null,
      varianteNombre: '',
      atributos: [],
      agregados: []
    }));

    if (itemsVenta.length === 0) {
      return res.status(400).json({ error: 'La comanda no tiene items para cobrar' });
    }

    const total = Number(comanda.total) || 0;
    const tipoPedido = tipoPedidoInput || `restaurante mesa ${comanda.mesa?.numero || ''}`.trim();
    const cobradorNombre = sanitizeOptionalText(req.body?.cobrador_nombre, { max: 120 })
      || sanitizeOptionalText(req.body?.nombre_cobrador, { max: 120 })
      || '';

    const venta = await Venta.create({
      productos: itemsVenta,
      total,
      tipo_pago: tipoPago,
      tipo_pedido: tipoPedido,
      monto_recibido: montoRecibido,
      vuelto,
      origen_cobro: 'caja_restaurante',
      mesa_numero: Number(comanda.mesa?.numero) || null,
      cobrador_nombre: cobradorNombre,
      rendicion_efectivo_pendiente: false,
      rendido_en: tipoPago.toLowerCase() === 'efectivo' ? null : new Date(),
      fecha: new Date(),
      numero_pedido: Math.floor(Math.random() * 100000),
      local: req.localId,
      usuario: req.userId || null
    });

    comanda.estado = 'cerrada';
    comanda.cerradaEn = new Date();
    comanda.cobradaEn = new Date();
    comanda.cobradaPor = req.userId || null;
    comanda.tipo_pago = tipoPago;
    comanda.tipo_pedido = tipoPedido;
    comanda.origen_cobro = 'caja';
    comanda.rendicion_efectivo_pendiente = false;
    comanda.rendidoEn = tipoPago.toLowerCase() === 'efectivo' ? null : new Date();
    comanda.ventaId = venta._id;
    await comanda.save();

    await cerrarMesaSiCorresponde(req.localId, comanda.mesa?._id, comanda._id);

    res.json({
      mensaje: 'Comanda cobrada correctamente',
      venta: {
        _id: venta._id,
        numero_pedido: venta.numero_pedido,
        productos: venta.productos,
        total: venta.total,
        tipo_pago: venta.tipo_pago,
        tipo_pedido: venta.tipo_pedido,
        monto_recibido: venta.monto_recibido,
        vuelto: venta.vuelto,
        fecha: venta.fecha
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al cobrar la comanda' });
  }
});

router.post('/comandas/:id/cobrar-mesa', async (req, res) => {
  try {
    if (!esMeseroOCobrador(req.userRole)) {
      return res.status(403).json({ error: 'No tienes permisos para cobrar en mesa' });
    }

    const tipoPago = sanitizeText(req.body?.tipo_pago, { max: 30 });
    const tipoPedidoInput = sanitizeOptionalText(req.body?.tipo_pedido, { max: 40 }) || '';
    const cobradorNombre = sanitizeOptionalText(req.body?.cobrador_nombre, { max: 120 }) || '';
    const montoRecibidoInput = req.body?.monto_recibido;
    const vueltoInput = req.body?.vuelto;

    if (!tipoPago) {
      return res.status(400).json({ error: 'Tipo de pago requerido' });
    }

    const montoRecibido =
      montoRecibidoInput === null || montoRecibidoInput === undefined || montoRecibidoInput === ''
        ? null
        : Number(montoRecibidoInput);
    if (montoRecibido !== null && (Number.isNaN(montoRecibido) || montoRecibido < 0)) {
      return res.status(400).json({ error: 'Monto recibido invalido' });
    }

    const vuelto =
      vueltoInput === null || vueltoInput === undefined || vueltoInput === ''
        ? null
        : Number(vueltoInput);
    if (vuelto !== null && Number.isNaN(vuelto)) {
      return res.status(400).json({ error: 'Vuelto invalido' });
    }

    const cajaAbierta = await Caja.findOne({ cierre: null, local: req.localId });
    if (!cajaAbierta) {
      return res.status(400).json({ error: 'Debes abrir la caja antes de cobrar en mesa' });
    }

    const comanda = await RestauranteComanda.findOne({
      _id: req.params.id,
      local: req.localId
    }).populate('mesa', 'numero nombre estado');

    if (!comanda) {
      return res.status(404).json({ error: 'Comanda no encontrada' });
    }
    if (comanda.estado === 'cerrada' || comanda.estado === 'cancelada') {
      return res.status(400).json({ error: 'La comanda ya esta cerrada o cancelada' });
    }
    if (req.userRole === 'mesero' && String(comanda.mesero || '') !== String(req.userId || '')) {
      return res.status(403).json({ error: 'No puedes cobrar en mesa comandas de otro mesero' });
    }

    const itemsVenta = (comanda.items || []).map((item) => ({
      productoId: item.productoId,
      nombre: item.nombre,
      precio_unitario: Number(item.precio_unitario) || 0,
      cantidad: Number(item.cantidad) || 0,
      observacion: item.nota || '',
      varianteId: null,
      varianteNombre: '',
      atributos: [],
      agregados: []
    }));

    if (itemsVenta.length === 0) {
      return res.status(400).json({ error: 'La comanda no tiene items para cobrar' });
    }

    const total = Number(comanda.total) || 0;
    const tipoPedido = tipoPedidoInput || `restaurante mesa ${comanda.mesa?.numero || ''}`.trim();
    const pagoEsEfectivo = tipoPago.toLowerCase() === 'efectivo';

    const venta = await Venta.create({
      productos: itemsVenta,
      total,
      tipo_pago: tipoPago,
      tipo_pedido: tipoPedido,
      monto_recibido: montoRecibido,
      vuelto,
      origen_cobro: 'mesa_restaurante',
      mesa_numero: Number(comanda.mesa?.numero) || null,
      cobrador_nombre: cobradorNombre,
      rendicion_efectivo_pendiente: pagoEsEfectivo,
      rendido_en: pagoEsEfectivo ? null : new Date(),
      fecha: new Date(),
      numero_pedido: Math.floor(Math.random() * 100000),
      local: req.localId,
      usuario: req.userId || null
    });

    comanda.estado = 'cerrada';
    comanda.cerradaEn = new Date();
    comanda.cobradaEn = new Date();
    comanda.cobradaPor = req.userId || null;
    comanda.tipo_pago = tipoPago;
    comanda.tipo_pedido = tipoPedido;
    comanda.origen_cobro = 'mesa';
    comanda.rendicion_efectivo_pendiente = pagoEsEfectivo;
    comanda.rendidoEn = pagoEsEfectivo ? null : new Date();
    comanda.ventaId = venta._id;
    await comanda.save();

    await cerrarMesaSiCorresponde(req.localId, comanda.mesa?._id, comanda._id);

    res.json({
      mensaje: 'Comanda cobrada en mesa correctamente',
      venta: {
        _id: venta._id,
        numero_pedido: venta.numero_pedido,
        productos: venta.productos,
        total: venta.total,
        tipo_pago: venta.tipo_pago,
        tipo_pedido: venta.tipo_pedido,
        monto_recibido: venta.monto_recibido,
        vuelto: venta.vuelto,
        origen_cobro: venta.origen_cobro,
        cobrador_nombre: venta.cobrador_nombre,
        fecha: venta.fecha
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al cobrar comanda en mesa' });
  }
});

router.get('/caja/rendiciones-pendientes', async (req, res) => {
  try {
    if (!esCobrador(req.userRole)) {
      return res.status(403).json({ error: 'No tienes permisos para ver rendiciones pendientes' });
    }

    const pendientes = await RestauranteComanda.find({
      local: req.localId,
      estado: 'cerrada',
      tipo_pago: /^efectivo$/i,
      origen_cobro: 'mesa',
      rendicion_efectivo_pendiente: true
    })
      .populate('mesa', 'numero nombre zona')
      .populate('mesero', 'nombre email rol')
      .populate('cobradaPor', 'nombre email rol')
      .sort({ cerradaEn: -1 });

    res.json(pendientes);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener rendiciones pendientes' });
  }
});

router.post('/caja/rendir/:id', async (req, res) => {
  try {
    if (!esCobrador(req.userRole)) {
      return res.status(403).json({ error: 'No tienes permisos para rendir cobros en mesa' });
    }

    const comanda = await RestauranteComanda.findOne({
      _id: req.params.id,
      local: req.localId
    });
    if (!comanda) {
      return res.status(404).json({ error: 'Comanda no encontrada' });
    }
    if (comanda.estado !== 'cerrada' || !comanda.rendicion_efectivo_pendiente) {
      return res.status(400).json({ error: 'La comanda no tiene rendicion pendiente' });
    }

    comanda.rendicion_efectivo_pendiente = false;
    comanda.rendidoEn = new Date();
    await comanda.save();

    if (comanda.ventaId) {
      await Venta.updateOne(
        { _id: comanda.ventaId, local: req.localId },
        { $set: { rendicion_efectivo_pendiente: false, rendido_en: new Date() } }
      );
    }

    res.json({ mensaje: 'Rendicion registrada' });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar rendicion' });
  }
});

module.exports = router;
