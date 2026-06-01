const mongoose = require('mongoose');

const reciboConfigSchema = new mongoose.Schema(
  {
    local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', required: true, unique: true },
    nombre: { type: String, default: 'Ticket de Venta' },
    logo_url: { type: String, default: '' },
    logo_cloudinary_id: { type: String, default: '' },
    pie: { type: String, default: '' },
    imprimir_auto: { type: Boolean, default: true },
    copias_auto: { type: Number, default: 1 },
    actualizado_en: { type: Date, default: Date.now }
  }
);

module.exports = mongoose.model('ReciboConfig', reciboConfigSchema);
