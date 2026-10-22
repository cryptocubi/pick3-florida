-- Pronósticos que deja la gente para cada sorteo
CREATE TABLE IF NOT EXISTS pronosticos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,        -- AAAA-MM-DD del sorteo (hora de Florida)
  sorteo TEXT NOT NULL,       -- M = mediodía, T = noche
  nombre TEXT NOT NULL,       -- apodo que elige la persona
  dispositivo TEXT NOT NULL,  -- id al azar guardado en su teléfono (uno por sorteo)
  numeros TEXT NOT NULL,      -- fijos separados por coma, ej. "18,43,94"
  ip TEXT NOT NULL,           -- huella de la IP (con sal), solo para frenar abusos
  creado TEXT NOT NULL,
  UNIQUE (fecha, sorteo, dispositivo)
);
CREATE INDEX IF NOT EXISTS idx_sorteo ON pronosticos (fecha, sorteo);
CREATE INDEX IF NOT EXISTS idx_ip ON pronosticos (ip, creado);

-- Reportes de pronósticos ofensivos (con 3 de teléfonos distintos, el pronóstico se esconde)
CREATE TABLE IF NOT EXISTS reportes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pronostico_id INTEGER NOT NULL,
  dispositivo TEXT NOT NULL,
  motivo TEXT NOT NULL,
  creado TEXT NOT NULL,
  UNIQUE (pronostico_id, dispositivo)
);
CREATE INDEX IF NOT EXISTS idx_rep ON reportes (pronostico_id);

-- Teléfonos que quieren aviso cuando sale el número (app de las tiendas)
CREATE TABLE IF NOT EXISTS avisos (
  token TEXT PRIMARY KEY,     -- token de notificaciones de Expo
  m INTEGER NOT NULL,         -- 1 = avisar el de mediodía
  t INTEGER NOT NULL,         -- 1 = avisar el de noche
  plataforma TEXT NOT NULL,
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL
);
-- Sorteos ya avisados (para no avisar dos veces)
CREATE TABLE IF NOT EXISTS enviados (
  fecha TEXT NOT NULL,
  sorteo TEXT NOT NULL,
  numero TEXT NOT NULL,
  creado TEXT NOT NULL,
  PRIMARY KEY (fecha, sorteo)
);

-- Cuántas preguntas a la IA hace cada teléfono al día (sin guardar el texto)
CREATE TABLE IF NOT EXISTS uso_ia (
  quien TEXT NOT NULL,   -- huella del teléfono (con sal)
  fecha TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (quien, fecha)
);
