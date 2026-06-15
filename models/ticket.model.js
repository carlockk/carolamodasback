const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  nombre: String,
  productos: [
    {
      productoId: mongoose.Schema.Types.ObjectId,
      nombre: String,
      precio_unitario: Number,
      precio_original: Number,
      descuento: { type: Object, default: null },
      cantidad: Number,
      observacion: String,
      varianteId: mongoose.Schema.Types.ObjectId,
      varianteNombre: String,
      atributos: [
        {
          nombre: String,
          valor: String
        }
      ],
      agregados: [
        {
          agregadoId: mongoose.Schema.Types.ObjectId,
          nombre: String,
          precio: Number
        }
      ]
    }
  ],
  total: Number,
  subtotal: Number,
  descuento_total: { type: Number, default: 0 },
  descuento_venta: { type: Object, default: null },
  usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', default: null },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', default: null },
  creado: {
    type: Date,
    default: () => new Date()
  }
});

module.exports = mongoose.model('Ticket', ticketSchema);
