const mongoose = require('mongoose');

const descuentoSchema = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true },
  tipo: { type: String, enum: ['porcentaje', 'fijo'], required: true },
  valor: { type: Number, required: true, min: 0 },
  activo: { type: Boolean, default: true },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', required: true },
  creado_por: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', default: null },
  creado_en: { type: Date, default: Date.now },
  actualizado_en: { type: Date, default: Date.now }
});

descuentoSchema.index({ local: 1, nombre: 1 }, { unique: true });

module.exports = mongoose.model('Descuento', descuentoSchema);
