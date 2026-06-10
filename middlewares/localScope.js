const mongoose = require('mongoose');
const { getAuthPayloadFromRequest } = require('../utils/authToken');

const normalizarRol = (rol) =>
  typeof rol === 'string' ? rol.trim().toLowerCase() : '';

const esGetCatalogoPublico = (req) => {
  const method = String(req.method || '').toUpperCase();
  if (method !== 'GET') return false;

  const baseUrl = String(req.baseUrl || '');
  const path = String(req.path || '');

  if (baseUrl === '/api/productos') {
    if (path === '/') return true;
    const id = path.startsWith('/') ? path.slice(1) : path;
    return mongoose.Types.ObjectId.isValid(id);
  }

  if (baseUrl === '/api/categorias') {
    if (path === '/') return true;
    const id = path.startsWith('/') ? path.slice(1) : path;
    return mongoose.Types.ObjectId.isValid(id);
  }

  if (baseUrl === '/api/agregados') {
    return path === '/opciones';
  }

  if (baseUrl === '/api/social-config') {
    return path === '/public';
  }

  return false;
};

const puedeUsarHeaderLocalSinLocalEnToken = (role) =>
  ['public', 'cliente'].includes(normalizarRol(role));

const adjuntarScopeLocal = (req, res, next) => {
  const payload = req.auth || getAuthPayloadFromRequest(req);
  const allowLegacyHeaders = process.env.ALLOW_LEGACY_SCOPE_HEADERS === 'true';
  const allowPublicCatalog = process.env.ALLOW_PUBLIC_CATALOG !== 'false';

  if (!payload && !allowLegacyHeaders) {
    if (allowPublicCatalog && esGetCatalogoPublico(req)) {
      const localRaw = req.headers['x-local-id'];
      if (!localRaw || String(localRaw).trim() === '') {
        return res.status(400).json({ error: 'Local requerido' });
      }
      if (!mongoose.Types.ObjectId.isValid(localRaw)) {
        return res.status(400).json({ error: 'Local invalido' });
      }
      req.userRole = 'public';
      req.localId = String(localRaw);
      req.userId = null;
      return next();
    }
    return res.status(401).json({ error: 'No autenticado' });
  }

  const headerRole = normalizarRol(req.headers['x-user-role']);
  const headerLocalRaw = req.headers['x-local-id'];
  const headerUserRaw = req.headers['x-user-id'];

  req.userRole = '';
  req.localId = null;
  req.userId = null;

  if (payload) {
    const roleFromToken = normalizarRol(payload.rol);
    const localFromToken = payload.localId ? String(payload.localId) : '';
    const userFromToken = payload.id ? String(payload.id) : '';

    if (userFromToken && !mongoose.Types.ObjectId.isValid(userFromToken)) {
      return res.status(401).json({ error: 'Token invalido' });
    }
    if (localFromToken && !mongoose.Types.ObjectId.isValid(localFromToken)) {
      return res.status(401).json({ error: 'Token invalido' });
    }

    req.userRole = roleFromToken;
    req.userId = userFromToken || null;

    if (roleFromToken === 'superadmin') {
      if (headerLocalRaw !== undefined && headerLocalRaw !== null && String(headerLocalRaw).trim() !== '') {
        if (!mongoose.Types.ObjectId.isValid(headerLocalRaw)) {
          return res.status(400).json({ error: 'Local invalido' });
        }
        req.localId = String(headerLocalRaw);
      } else {
        req.localId = localFromToken || null;
      }
    } else {
      // Para tokens sin local embebido (ej. cliente web), se permite elegir local por header.
      const puedeElegirLocalPorHeader =
        !localFromToken && puedeUsarHeaderLocalSinLocalEnToken(roleFromToken);
      if (
        headerLocalRaw !== undefined &&
        headerLocalRaw !== null &&
        String(headerLocalRaw).trim() !== '' &&
        localFromToken &&
        String(headerLocalRaw) !== localFromToken
      ) {
        return res.status(403).json({ error: 'No puedes operar sobre otro local' });
      }
      if (!localFromToken && headerLocalRaw !== undefined && String(headerLocalRaw).trim() !== '' && !puedeElegirLocalPorHeader) {
        return res.status(403).json({ error: 'No puedes operar sobre un local por header' });
      }
      if (puedeElegirLocalPorHeader && headerLocalRaw !== undefined && String(headerLocalRaw).trim() !== '') {
        if (!mongoose.Types.ObjectId.isValid(headerLocalRaw)) {
          return res.status(400).json({ error: 'Local invalido' });
        }
        req.localId = String(headerLocalRaw);
      } else {
        req.localId = localFromToken || null;
      }
    }

    return next();
  }

  req.userRole = headerRole;

  if (headerLocalRaw !== undefined && headerLocalRaw !== null && String(headerLocalRaw).trim() !== '') {
    if (!mongoose.Types.ObjectId.isValid(headerLocalRaw)) {
      return res.status(400).json({ error: 'Local invalido' });
    }
    req.localId = String(headerLocalRaw);
  }

  if (headerUserRaw !== undefined && headerUserRaw !== null && String(headerUserRaw).trim() !== '') {
    if (!mongoose.Types.ObjectId.isValid(headerUserRaw)) {
      return res.status(400).json({ error: 'Usuario invalido' });
    }
    req.userId = String(headerUserRaw);
  }

  return next();
};

const requiereLocal = (req, res, next) => {
  if (!req.localId) {
    return res.status(400).json({ error: 'Local requerido' });
  }
  return next();
};

module.exports = {
  adjuntarScopeLocal,
  requiereLocal
};
