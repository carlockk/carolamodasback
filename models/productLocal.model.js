const mongoose = require('mongoose');

const varianteLocalSchema = new mongoose.Schema(
  {
    baseVarianteId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    nombre: { type: String, required: true, trim: true },
    color: { type: String, trim: true },
    talla: { type: String, trim: true },
    precio: { type: Number },
    stock: { type: Number, default: null },
    agotado: { type: Boolean, default: false },
    sku: { type: String, trim: true }
  },
  { _id: true }
);

const productLocalSchema = new mongoose.Schema(
  {
    productoBase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductoBase',
      required: true
    },
    local: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Local',
      required: true
    },
    activo: { type: Boolean, default: true },
    precio: { type: Number, required: true },
    stock: { type: Number, default: null },
    agregados: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Agregado' }],
    variantes: [varianteLocalSchema],
    creado_en: { type: Date, default: Date.now }
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

productLocalSchema.index({ productoBase: 1, local: 1 }, { unique: true });
productLocalSchema.index({ local: 1, creado_en: -1 });

productLocalSchema.virtual('stock_total').get(function () {
  if (Array.isArray(this.variantes) && this.variantes.length > 0) {
    const stocks = this.variantes
      .map((vari) => {
        if (vari.stock === null || vari.stock === undefined || vari.stock === '') return null;
        const valor = Number(vari.stock);
        return Number.isFinite(valor) && valor >= 0 ? valor : null;
      })
      .filter((st) => st !== null);

    if (stocks.length === 0) return null;
    return stocks.reduce((acc, st) => acc + st, 0);
  }

  return typeof this.stock === 'number' ? this.stock : null;
});

module.exports = mongoose.model('ProductoLocal', productLocalSchema);
