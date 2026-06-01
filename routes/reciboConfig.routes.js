const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const ReciboConfig = require('../models/reciboConfig.model');
const { sanitizeOptionalText, sanitizeText } = require('../utils/input');
const { subirImagen, eliminarImagen } = require('../utils/cloudinary');
const { adjuntarScopeLocal, requiereLocal } = require('../middlewares/localScope');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(adjuntarScopeLocal);
router.use(requiereLocal);

const clampCopias = (value) => {
  if (value === undefined || value === null || value === '') return 1;
  const numero = Number(value);
  if (!Number.isFinite(numero) || numero < 0) {
    throw new Error('El numero de copias es invalido');
  }
  return Math.min(Math.round(numero), 5);
};

const obtenerConfig = async (localId) => {
  let config = await ReciboConfig.findOne({ local: localId });
  if (!config) {
    config = await ReciboConfig.create({ local: localId });
  }
  return config;
};

router.get('/', async (req, res) => {
  try {
    const config = await obtenerConfig(req.localId);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener configuracion de recibo' });
  }
});

router.put('/', upload.single('logo'), async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.userRole)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const config = await obtenerConfig(req.localId);

    const nombre = sanitizeOptionalText(req.body.nombre, { max: 120 });
    const pie = sanitizeOptionalText(req.body.pie, { max: 300 });
    const copias = clampCopias(req.body.copias_auto);
    const imprimirAuto = req.body.imprimir_auto === undefined
      ? config.imprimir_auto !== false
      : String(req.body.imprimir_auto) === 'true';
    const removeLogo = String(req.body.remove_logo) === 'true';

    if (nombre !== null && nombre !== undefined) {
      const limpio = sanitizeText(nombre, { max: 120 });
      if (!limpio) throw new Error('Nombre invalido');
      config.nombre = limpio;
    }
    if (pie !== null && pie !== undefined) {
      config.pie = pie || '';
    }
    config.imprimir_auto = imprimirAuto;
    config.copias_auto = copias;

    if (removeLogo && config.logo_cloudinary_id) {
      await eliminarImagen(config.logo_cloudinary_id);
      config.logo_cloudinary_id = '';
      config.logo_url = '';
    }

    if (req.file) {
      if (config.logo_cloudinary_id) {
        await eliminarImagen(config.logo_cloudinary_id);
      }
      const subida = await subirImagen(req.file);
      config.logo_url = subida.secure_url;
      config.logo_cloudinary_id = subida.public_id;
    }

    config.actualizado_en = new Date();
    const actualizado = await config.save();
    res.json(actualizado);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Error al guardar configuracion de recibo' });
  }
});

module.exports = router;
