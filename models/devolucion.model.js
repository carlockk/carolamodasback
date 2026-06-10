const mongoose = require('mongoose');

const devolucionSchema = new mongoose.Schema({
  venta: { type: mongoose.Schema.Types.ObjectId, ref: 'Venta', required: true },
  caja: { type: mongoose.Schema.Types.ObjectId, ref: 'Caja', required: true },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', required: true },
  usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', default: null },
  monto: { type: Number, required: true, min: 1 },
  motivo: { type: String, required: true, trim: true },
  tipo_pago: { type: String, required: true, trim: true },
  fecha: { type: Date, default: Date.now }
});

devolucionSchema.index({ local: 1, fecha: -1 });
devolucionSchema.index({ venta: 1, fecha: -1 });

module.exports = mongoose.model('Devolucion', devolucionSchema);
