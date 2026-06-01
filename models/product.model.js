// models/product.model.js
const mongoose = require('mongoose');

const varianteSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, trim: true },
    color: { type: String, trim: true },
    talla: { type: String, trim: true },
    precio: { type: Number }, // opcional, si no se usa el precio del producto padre
    stock: { type: Number, default: null },
    agotado: { type: Boolean, default: false },
    sku: { type: String, trim: true }
  },
  { _id: true }
);

const productSchema = new mongoose.Schema(
  {
    sku: { type: String, trim: true },
    nombre: { type: String, required: true, trim: true },
    descripcion: { type: String, trim: true },
    precio: { type: Number, required: true },
    stock: { type: Number, default: null }, // stock base (sin variantes) o total precalculado
    variantes: [varianteSchema], // variantes opcionales
    imagen_url: { type: String },
    cloudinary_id: { type: String },
    categoria: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Categoria',
      default: null
    },
    local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', default: null },
    creado_en: { type: Date, default: Date.now }
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual para calcular stock_total en runtime
productSchema.virtual('stock_total').get(function () {
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

module.exports = mongoose.model('Producto', productSchema);
