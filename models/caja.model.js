const mongoose = require('mongoose');

const cajaSchema = new mongoose.Schema({
  apertura: { type: Date, default: Date.now },
  cierre: Date,
  monto_inicial: { type: Number, required: true },
  monto_total_vendido: Number,
  monto_total_devoluciones: { type: Number, default: 0 },
  monto_total_neto: Number,
  monto_total_final: Number,
  desglose_por_pago: { type: Object, default: {} },
  desglose_devoluciones_por_pago: { type: Object, default: {} },
  devoluciones: { type: Array, default: [] },
  usuario: { type: String, default: 'No registrado' },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', default: null }
});

module.exports = mongoose.model('Caja', cajaSchema);
