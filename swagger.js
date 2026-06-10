const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "POS API - Documentación",
      version: "1.0.0",
      description: "API del sistema POS con autenticación, productos, ventas y más",
    },
    servers: [
      {
        url: "https://carolamodasback.onrender.com/api",
        description: "Render (Producción)",
      },
      {
        url: "http://localhost:5000/api",
        description: "Local (Desarrollo)",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{
      bearerAuth: [],
    }],
  },
  apis: ["./routes/*.js"], // Aquí Swagger busca los comentarios JSDoc
};

const specs = swaggerJsdoc(options);

module.exports = { swaggerUi, specs };
