const mongoose = require('mongoose');

const productMermaSchema = new mongoose.Schema(
  {
    producto: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductoLocal',
      required: true
    },
    productoBase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductoBase',
      default: null
    },
    varianteId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    varianteNombre: {
      type: String,
      trim: true,
      default: ''
    },
    local: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Local',
      required: true
    },
    cantidad: {
      type: Number,
      required: true,
      min: 1
    },
    stock_antes: {
      type: Number,
      required: true,
      min: 0
    },
    stock_despues: {
      type: Number,
      required: true,
      min: 0
    },
    nota: {
      type: String,
      trim: true,
      default: ''
    },
    usuario: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Usuario',
      default: null
    },
    creado_en: {
      type: Date,
      default: Date.now
    }
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

productMermaSchema.index({ local: 1, creado_en: -1 });
productMermaSchema.index({ producto: 1, creado_en: -1 });

module.exports = mongoose.model('ProductoMerma', productMermaSchema);
