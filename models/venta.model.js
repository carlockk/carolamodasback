const mongoose = require('mongoose');

const ventaSchema = new mongoose.Schema({
  numero_pedido: Number,
  productos: [
    {
      productoId: mongoose.Schema.Types.ObjectId,
      nombre: String,
      precio_unitario: Number,
      precio_original: Number,
      descuento: {
        descuentoId: mongoose.Schema.Types.ObjectId,
        nombre: String,
        tipo: String,
        valor: Number,
        monto: Number
      },
      cantidad: Number,
      stock_descontado: Boolean,
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
  descuento_venta: {
    descuentoId: mongoose.Schema.Types.ObjectId,
    nombre: String,
    tipo: String,
    valor: Number,
    monto: Number
  },
  tipo_pago: String,
  pagos: [
    {
      tipo: String,
      monto: Number
    }
  ],
  tipo_pedido: String,
  monto_recibido: { type: Number, default: null },
  vuelto: { type: Number, default: null },
  origen_cobro: { type: String, default: 'pos' },
  mesa_numero: { type: Number, default: null },
  cobrador_nombre: { type: String, default: '' },
  rendicion_efectivo_pendiente: { type: Boolean, default: false },
  rendido_en: { type: Date, default: null },
  usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', default: null },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', default: null },
  caja: { type: mongoose.Schema.Types.ObjectId, ref: 'Caja', default: null },
  revision: { type: Number, default: 0 },
  estado: { type: String, enum: ['vigente', 'anulada'], default: 'vigente' },
  anulacion: {
    fecha: Date,
    motivo: String,
    usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    caja: { type: mongoose.Schema.Types.ObjectId, ref: 'Caja' }
  },
  fecha: {
    type: Date,
    default: () => new Date()
  }
});

ventaSchema.index({ local: 1, estado: 1, 'anulacion.fecha': -1 });

module.exports = mongoose.model('Venta', ventaSchema);
