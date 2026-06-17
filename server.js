const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const path = require("path");
const { restringirMesero } = require("./middlewares/roleAccess");
const { ensureJwtConfig } = require("./utils/jwtConfig");

// Cargar variables de entorno
dotenv.config();
ensureJwtConfig();

const app = express();
const PORT = process.env.PORT || 5000;

// 🛡️ Middleware
const normalizeOrigin = (value) =>
  String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\/+$/, "");

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);
const allowLocalhostCors = String(process.env.CORS_ALLOW_LOCALHOST || "false").toLowerCase() === "true";
const extraOrigins = allowLocalhostCors
  ? Array.from({ length: 10 }, (_, idx) => 5173 + idx)
      .flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`])
      .map((origin) => normalizeOrigin(origin))
  : [];
const allowVercelPreviewCors =
  String(process.env.CORS_ALLOW_VERCEL_PREVIEW || "false").toLowerCase() === "true";
const mergedOrigins = Array.from(new Set([...allowedOrigins, ...extraOrigins]));
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && mergedOrigins.length === 0) {
  throw new Error("CORS_ORIGINS es obligatorio en produccion");
}

const corsOrigin = mergedOrigins.length
  ? (origin, callback) => {
      const requestOrigin = normalizeOrigin(origin);
      const isAllowedVercelPreview =
        allowVercelPreviewCors &&
        requestOrigin.startsWith("https://") &&
        requestOrigin.endsWith(".vercel.app");

      if (!requestOrigin || mergedOrigins.includes(requestOrigin) || isAllowedVercelPreview) {
        return callback(null, true);
      }
      return callback(new Error("Origen no permitido por CORS"));
    }
  : true;

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if (req.originalUrl === "/api/pagos/webhook") {
        req.rawBody = buf.toString();
      }
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    maxAge: "30d",
    immutable: true
  })
);
app.use(restringirMesero);

// 🏠 Ruta raíz (para que no salga "Cannot GET /")
app.get("/", (req, res) => {
  res.send("✅ Backend POS funcionando");
});

// 🩺 Endpoint de healthcheck
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
    message: "Backend POS saludable",
  });
});

// 📦 Rutas
const productRoutes = require("./routes/product.routes.js");
const ventaRoutes = require("./routes/venta.routes.js");
const cajaRoutes = require("./routes/caja.routes.js");
const authRoutes = require("./routes/auth.routes.js");
const usuarioRoutes = require("./routes/usuario.routes.js");
const categoriaRoutes = require("./routes/categoria.routes.js");
const ticketRoutes = require("./routes/ticket.routes.js");
const clienteRoutes = require("./routes/cliente.routes");
const ventaClienteRoutes = require("./routes/ventaCliente.routes");
const pagosRoutes = require("./routes/pagos.routes");
const insumoRoutes = require("./routes/insumo.routes");
const insumoCategoriaRoutes = require("./routes/insumoCategoria.routes");
const localesRoutes = require("./routes/locales.routes");
const reciboConfigRoutes = require("./routes/reciboConfig.routes");
const agregadoRoutes = require("./routes/agregado.routes");
const socialConfigRoutes = require("./routes/socialConfig.routes");
const restauranteRoutes = require("./routes/restaurante.routes");
const descuentoRoutes = require("./routes/descuento.routes");

// Swagger
const { swaggerUi, specs } = require("./swagger");
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs)); // Swagger UI

// Prefijo /api para todas las rutas REST
app.use("/api/productos", productRoutes);
app.use("/api/ventas", ventaRoutes);
app.use("/api/caja", cajaRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/usuarios", usuarioRoutes);
app.use("/api/categorias", categoriaRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/clientes", clienteRoutes);
app.use("/api/ventasCliente", ventaClienteRoutes);
app.use("/api/pagos", pagosRoutes);
app.use("/api/insumos", insumoRoutes);
app.use("/api/insumo-categorias", insumoCategoriaRoutes);
app.use("/api/locales", localesRoutes);
app.use("/api/recibo-config", reciboConfigRoutes);
app.use("/api/agregados", agregadoRoutes);
app.use("/api/social-config", socialConfigRoutes);
app.use("/api/restaurante", restauranteRoutes);
app.use("/api/descuentos", descuentoRoutes);

// 🔌 Levantar servidor primero para evitar timeout en Render
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});

// 🔌 Conexión MongoDB
mongoose
  .connect(process.env.MONGO_URI, {
    dbName: "posaildb",
  })
  .then(() => {
    console.log("✅ Conectado a MongoDB");
  })
  .catch((err) => {
    console.error("❌ Error al conectar a MongoDB:", err);
  });
