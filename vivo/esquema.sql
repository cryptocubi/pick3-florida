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
