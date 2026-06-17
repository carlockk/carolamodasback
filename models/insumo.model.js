const mongoose = require('mongoose');

const observacionSchema = new mongoose.Schema(
  {
    texto: { type: String, required: true, trim: true, maxlength: 500 },
    creado_por: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', default: null },
    creado_en: { type: Date, default: Date.now },
    actualizado_en: { type: Date, default: Date.now }
  },
  { _id: true }
);

const insumoSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, trim: true },
    descripcion: { type: String, trim: true },
    sku: { type: String, trim: true },
    color: { type: String, trim: true },
    talla: { type: String, trim: true },
    imagen_url: { type: String, trim: true },
    producto_relacionado: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductoLocal',
      default: null
    },
    variante_relacionada: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    unidad: { type: String, required: true, trim: true },
    stock_total: { type: Number, default: 0 },
    stock_minimo: { type: Number, default: 0 },
    alerta_vencimiento_dias: { type: Number, default: 7 },
    last_alerta_stock_en: { type: Date, default: null },
    last_alerta_vencimiento_en: { type: Date, default: null },
    last_alerta_vencimiento_estado: { type: String, default: null },
    ultima_nota: { type: String, trim: true, default: null },
    observaciones: { type: [observacionSchema], default: [] },
    local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', required: true },
    categoria: { type: mongoose.Schema.Types.ObjectId, ref: 'InsumoCategoria', default: null },
    orden: { type: Number, default: 0 },
    activo: { type: Boolean, default: true },
    creado_en: { type: Date, default: Date.now },
    actualizado_en: { type: Date, default: Date.now }
  }
);

module.exports = mongoose.model('Insumo', insumoSchema);
