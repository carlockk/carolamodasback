const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const Usuario = require('./models/usuario.model.js');

dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || 'posaildb'
  });

  const email = 'carolaa.modass@gmail.com';
  const password = '96669823aBC';
  const nombre = 'Carola';
  const rol = 'superadmin';

  const hashedPassword = await bcrypt.hash(password, 10);
  const existente = await Usuario.findOne({ email });

  if (existente) {
    existente.password = hashedPassword;
    existente.nombre = nombre;
    existente.rol = rol;
    await existente.save();
    console.log('🔁 Superadmin actualizado');
  } else {
    await Usuario.create({ email, password: hashedPassword, nombre, rol });
    console.log('✅ Superadmin creado');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('❌ Error al crear superadmin:', err);
  process.exit(1);
});
