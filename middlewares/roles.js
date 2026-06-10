const normalizarRol = (rol) =>
  typeof rol === 'string' ? rol.trim().toLowerCase() : '';

const requiereRol = (...rolesPermitidos) => {
  const permitidos = new Set(rolesPermitidos.map(normalizarRol));

  return (req, res, next) => {
    const rol = normalizarRol(req.userRole);
    if (!permitidos.has(rol)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    return next();
  };
};

module.exports = {
  requiereRol
};
