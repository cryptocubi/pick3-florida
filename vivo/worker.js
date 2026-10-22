// Puente "en vivo" para la app Pick 3 Florida (Cloudflare Worker).
// Lee los últimos sorteos de LotteryUSA (y Lottery.net si hace falta) en el momento
// y se los da a la app, que desde su página no puede leer esos sitios directamente.
// Respuesta: {"hora": "...", "sorteos": {...Pick 3...}, "pick4": {...Pick 4...}}
// cada juego: {"AAAA-MM-DD": ["mañana"|null, "tarde"|null]}

const NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const JUEGOS = {
  sorteos: {
    cifras: 3, net: "pick-3",
    usa: ["https://www.lotteryusa.com/florida/midday-pick-3/year", "https://www.lotteryusa.com/florida/pick-3/year"],
  },
  pick4: {
    cifras: 4, net: "pick-4",
    usa: ["https://www.lotteryusa.com/florida/midday-pick-4/year", "https://www.lotteryusa.com/florida/pick-4/year"],
  },
};
const MESES = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const DIAS = 14;         // cuántos días recientes devuelve
const GUARDA_MS = 20000; // no volver a preguntar a las fuentes antes de 20 s

let guardado = null; // {cuando, cuerpo}

async function bajar(url) {
  const r = await fetch(url, { headers: {
    "User-Agent": NAVEGADOR,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  } });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.text();
}

function quitarEntidades(s) {
  return s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&");
}

// LotteryUSA a veces rechaza una petición suelta: hasta 3 intentos por página
async function bajarConReintentos(url) {
  let error;
  for (let intento = 0; intento < 3; intento++) {
    try { return await bajar(intento ? `${url}?v=${Date.now()}` : url); }
    catch (e) { error = e; await new Promise(r => setTimeout(r, 400 * (intento + 1))); }
  }
  throw error;
}

const cifrasRe = (n, sep) => Array(n).fill(String.raw`(\d)`).join(sep);

async function lotteryUSA(juego, sorteos) {
  const fallos = [];
  const patron = new RegExp(String.raw`^"\w+, (\w{3}) (\d+), (\d{4})","` + cifrasRe(juego.cifras, ", ") + '"');
  await Promise.all(juego.usa.map(async (url, i) => {
    let html;
    try { html = await bajarConReintentos(url); } catch (e) { fallos.push(e.message); return; }
    const m = html.match(/data-exportMenu-csv-value="([^"]*)"/);
    if (!m) { fallos.push("LotteryUSA cambió su página"); return; }
    for (const linea of quitarEntidades(m[1]).trim().split("\n").slice(1)) {
      const x = linea.match(patron);
      if (!x) continue;
      const fecha = `${x[3]}-${MESES[x[1]]}-${x[2].padStart(2, "0")}`;
      (sorteos[fecha] ??= [null, null])[i] = x.slice(4).join("");
    }
  }));
  if (fallos.length) throw new Error(fallos.join("; "));
}

function fechaFlorida(diasAtras) {
  const d = new Date(Date.now() - diasAtras * 86400000);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, url: `${p.month}-${p.day}-${p.year}` };
}

async function lotteryNet(juego, sorteos) {
  // Solo hoy y ayer (hora de Florida); el número viene seguido del Fireball
  await Promise.all([0, 1].map(async atras => {
    const f = fechaFlorida(atras);
    let html;
    try { html = await bajar(`https://www.lottery.net/florida/${juego.net}/numbers/${f.url}`); } catch { return; }
    const texto = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    [["Midday", 0], ["Evening", 1]].forEach(([nombre, i]) => {
      const x = texto.match(new RegExp(nombre + String.raw` \d+:\d+ [AP]M ` + cifrasRe(juego.cifras + 1, " ") + String.raw`\b`));
      if (x) (sorteos[f.iso] ??= [null, null])[i] ??= x.slice(1, juego.cifras + 1).join("");
    });
  }));
}

async function leerJuego(clave, juego, fallos) {
  const sorteos = {};
  await lotteryUSA(juego, sorteos).catch(e => fallos.push(`${clave} LotteryUSA: ${e.message}`));
  // Lottery.net rellena lo que LotteryUSA aún no tenga de hoy o ayer
  const hoy = fechaFlorida(0).iso, ayer = fechaFlorida(1).iso;
  const falta = [hoy, ayer].some(f => !sorteos[f] || !sorteos[f][0] || !sorteos[f][1]);
  if (falta) await lotteryNet(juego, sorteos).catch(e => fallos.push(`${clave} Lottery.net: ${e.message}`));
  const recientes = Object.keys(sorteos).sort().slice(-DIAS);
  return Object.fromEntries(recientes.map(f => [f, sorteos[f]]));
}

// Videos oficiales de los sorteos (lista de YouTube de la Lotería de Florida): salen ~4 min después
const LISTA_VIDEOS = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLeIaregq2XfmTwPbxbIQ5sEZ5aQbKcvXY";
async function leerVideos(fallos) {
  try {
    const xml = await bajar(LISTA_VIDEOS);
    const videos = {};
    for (const m of xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>[\s\S]*?<title>Pick (Midday|Evening) (\d\d)-(\d\d)-(\d{4})<\/title>/g)) {
      const fecha = `${m[5]}-${m[3]}-${m[4]}`;
      (videos[fecha] ??= [null, null])[m[2] === "Midday" ? 0 : 1] ??= m[1];
    }
    return videos;
  } catch (e) { fallos.push("Videos: " + e.message); return {}; }
}

async function leer() {
  const fallos = [];
  const [[sorteos, pick4], videos] = await Promise.all([
    Promise.all(Object.entries(JUEGOS).map(([c, j]) => leerJuego(c, j, fallos))),
    leerVideos(fallos),
  ]);
  return { hora: new Date().toISOString(), sorteos, pick4, videos, ...(fallos.length ? { fallos } : {}) };
}

/* ---------- PRONÓSTICOS DE LA GENTE (base de datos D1) ---------- */
const CIERRE = { M: 13 * 60 + 25, T: 21 * 60 + 40 }; // se cierra 5 minutos antes del sorteo
const PALABROTAS = ["mierda", "puta", "puto", "pinga", "singao", "singado", "cojone", "maricon", "maricón", "comemierda", "culo", "verga", "pendejo", "cabron", "cabrón", "hijueputa", "fuck", "shit", "bitch"];

function ahoraFlorida() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutos: (+p.hour % 24) * 60 + +p.minute };
}
// Los dos próximos sorteos que aún aceptan pronósticos
function abiertos() {
  const { fecha, minutos } = ahoraFlorida();
  const manana = fechaFlorida(-1).iso;
  const lista = [];
  if (minutos < CIERRE.M) lista.push({ fecha, sorteo: "M" });
  if (minutos < CIERRE.T) lista.push({ fecha, sorteo: "T" });
  lista.push({ fecha: manana, sorteo: "M" }, { fecha: manana, sorteo: "T" });
  return lista.slice(0, 2);
}
async function huella(texto) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const json = (datos, cors, status = 200) => new Response(JSON.stringify(datos), { status, headers: cors });
const fechaOk = f => /^\d{4}-\d{2}-\d{2}$/.test(f || "");

function limpiarNombre(n) {
  n = String(n || "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (n.length < 2 || n.length > 20) return { error: "El apodo debe tener entre 2 y 20 letras." };
  if (!/^[\p{L}\p{N} ._-]+$/u.test(n)) return { error: "El apodo solo puede llevar letras, números, espacios, punto o guion." };
  const plano = n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
  if (PALABROTAS.some(p => plano.includes(p.normalize("NFD").replace(/[\u0300-\u036f]/g, "")))) return { error: "Ese apodo no está permitido. Elige otro." };
  return { nombre: n };
}

async function pronosticos(request, env, cors) {
  if (!env.DB) return json({ error: "Sin base de datos" }, cors, 503);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/pronosticos") {
    const fecha = url.searchParams.get("fecha"), sorteo = url.searchParams.get("sorteo");
    if (!fechaOk(fecha) || !["M", "T"].includes(sorteo)) return json({ error: "Falta fecha o sorteo" }, cors, 400);
    const { results } = await env.DB.prepare("SELECT nombre, numeros, creado, dispositivo FROM pronosticos WHERE fecha = ? AND sorteo = ? ORDER BY creado DESC LIMIT 500").bind(fecha, sorteo).all();
    const lista = await Promise.all(results.map(async r => ({ nombre: r.nombre, numeros: r.numeros.split(","), creado: r.creado, quien: (await huella(r.dispositivo)).slice(0, 10) })));
    return json({ fecha, sorteo, abiertos: abiertos(), lista }, cors);
  }

  if (request.method === "GET" && url.pathname === "/pronosticos/recientes") {
    const dias = Math.min(90, Math.max(1, +url.searchParams.get("dias") || 30));
    const desde = fechaFlorida(dias).iso;
    const { results } = await env.DB.prepare("SELECT fecha, sorteo, nombre, numeros, dispositivo FROM pronosticos WHERE fecha >= ? ORDER BY fecha LIMIT 20000").bind(desde).all();
    const lista = await Promise.all(results.map(async r => ({ fecha: r.fecha, sorteo: r.sorteo, nombre: r.nombre, numeros: r.numeros.split(","), quien: (await huella(r.dispositivo)).slice(0, 10) })));
    return json({ desde, abiertos: abiertos(), lista }, cors);
  }

  if (request.method === "POST" && url.pathname === "/pronosticos") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "No entendí el pronóstico." }, cors, 400); }
    const { fecha, sorteo, dispositivo } = b || {};
    if (!abiertos().some(a => a.fecha === fecha && a.sorteo === sorteo)) return json({ error: "Ese sorteo ya cerró. Elige el próximo." }, cors, 400);
    if (!/^[a-z0-9]{16,40}$/.test(dispositivo || "")) return json({ error: "Falta el identificador del teléfono." }, cors, 400);
    const nom = limpiarNombre(b.nombre);
    if (nom.error) return json({ error: nom.error }, cors, 400);
    const numeros = [...new Set((Array.isArray(b.numeros) ? b.numeros : []).map(n => String(n).trim()))];
    if (numeros.length < 1 || numeros.length > 3 || !numeros.every(n => /^\d{2}$/.test(n))) return json({ error: "Pon de 1 a 3 fijos, del 00 al 99." }, cors, 400);

    const ip = await huella((request.headers.get("CF-Connecting-IP") || "?") + "|" + (env.SAL || "pick3"));
    const haceUnaHora = new Date(Date.now() - 3600e3).toISOString();
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM pronosticos WHERE ip = ? AND creado > ?").bind(ip, haceUnaHora).first();
    if (n >= 30) return json({ error: "Demasiados pronósticos seguidos. Prueba en un rato." }, cors, 429);

    await env.DB.prepare(`INSERT INTO pronosticos (fecha, sorteo, nombre, dispositivo, numeros, ip, creado) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (fecha, sorteo, dispositivo) DO UPDATE SET nombre = excluded.nombre, numeros = excluded.numeros, ip = excluded.ip, creado = excluded.creado`)
      .bind(fecha, sorteo, nom.nombre, dispositivo, numeros.join(","), ip, new Date().toISOString()).run();
    return json({ ok: true, fecha, sorteo, nombre: nom.nombre, numeros }, cors);
  }
  return json({ error: "No encontrado" }, cors, 404);
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (new URL(request.url).pathname.startsWith("/pronosticos")) {
      try { return await pronosticos(request, env, cors); }
      catch (e) { return json({ error: "No se pudo guardar. Prueba otra vez." }, cors, 500); }
    }
    try {
      if (!guardado || Date.now() - guardado.cuando > GUARDA_MS) {
        guardado = { cuando: Date.now(), cuerpo: JSON.stringify(await leer()) };
      }
      return new Response(guardado.cuerpo, { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
    }
  },
};
