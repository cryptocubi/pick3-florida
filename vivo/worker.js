import { preguntarIA } from "./ia.js";
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
const GUARDA_MS = 8000; // no volver a preguntar a las fuentes antes de 8 s

let guardado = null; // {cuando, cuerpo}

async function bajar(url) {
  // cache "no-store": que Cloudflare no nos dé una copia vieja de la página de resultados
  const r = await fetch(url, { cache: "no-store", headers: {
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
    const { results } = await env.DB.prepare("SELECT p.id, p.nombre, p.numeros, p.creado, p.dispositivo FROM pronosticos p WHERE p.fecha = ? AND p.sorteo = ? AND (SELECT COUNT(*) FROM reportes r WHERE r.pronostico_id = p.id) < 3 ORDER BY p.creado DESC LIMIT 500").bind(fecha, sorteo).all();
    const lista = await Promise.all(results.map(async r => ({ id: r.id, nombre: r.nombre, numeros: r.numeros.split(","), creado: r.creado, quien: (await huella(r.dispositivo)).slice(0, 10) })));
    return json({ fecha, sorteo, abiertos: abiertos(), lista }, cors);
  }

  if (request.method === "GET" && url.pathname === "/pronosticos/recientes") {
    const dias = Math.min(90, Math.max(1, +url.searchParams.get("dias") || 30));
    const desde = fechaFlorida(dias).iso;
    const { results } = await env.DB.prepare("SELECT p.id, p.fecha, p.sorteo, p.nombre, p.numeros, p.dispositivo FROM pronosticos p WHERE p.fecha >= ? AND (SELECT COUNT(*) FROM reportes r WHERE r.pronostico_id = p.id) < 3 ORDER BY p.fecha LIMIT 20000").bind(desde).all();
    const lista = await Promise.all(results.map(async r => ({ id: r.id, fecha: r.fecha, sorteo: r.sorteo, nombre: r.nombre, numeros: r.numeros.split(","), quien: (await huella(r.dispositivo)).slice(0, 10) })));
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
  // Reportar un pronóstico ofensivo: con 3 reportes de teléfonos distintos deja de verse
  if (request.method === "POST" && url.pathname === "/pronosticos/reportar") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "No entendí el reporte." }, cors, 400); }
    const id = +b?.id, dispositivo = b?.dispositivo || "", motivo = String(b?.motivo || "ofensivo").slice(0, 40);
    if (!Number.isInteger(id) || id < 1) return json({ error: "Falta el pronóstico." }, cors, 400);
    if (!/^[a-z0-9]{16,40}$/.test(dispositivo)) return json({ error: "Falta el identificador del teléfono." }, cors, 400);
    const existe = await env.DB.prepare("SELECT id FROM pronosticos WHERE id = ?").bind(id).first();
    if (!existe) return json({ error: "Ese pronóstico ya no existe." }, cors, 404);
    await env.DB.prepare("INSERT OR IGNORE INTO reportes (pronostico_id, dispositivo, motivo, creado) VALUES (?, ?, ?, ?)")
      .bind(id, dispositivo, motivo, new Date().toISOString()).run();
    return json({ ok: true }, cors);
  }

  // Borrar mi propio pronóstico
  if (request.method === "POST" && url.pathname === "/pronosticos/borrar") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "No entendí la petición." }, cors, 400); }
    const { fecha, sorteo, dispositivo } = b || {};
    if (!fechaOk(fecha) || !["M", "T"].includes(sorteo) || !/^[a-z0-9]{16,40}$/.test(dispositivo || "")) return json({ error: "Faltan datos." }, cors, 400);
    const r = await env.DB.prepare("DELETE FROM pronosticos WHERE fecha = ? AND sorteo = ? AND dispositivo = ?").bind(fecha, sorteo, dispositivo).run();
    return json({ ok: true, borrados: r.meta?.changes ?? 0 }, cors);
  }

  // Borrar todo lo de este teléfono (lo piden las tiendas: el usuario puede eliminar sus datos)
  if (request.method === "POST" && url.pathname === "/pronosticos/borrar-todo") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "No entendí la petición." }, cors, 400); }
    const dispositivo = b?.dispositivo || "";
    if (!/^[a-z0-9]{16,40}$/.test(dispositivo)) return json({ error: "Faltan datos." }, cors, 400);
    const r = await env.DB.prepare("DELETE FROM pronosticos WHERE dispositivo = ?").bind(dispositivo).run();
    await env.DB.prepare("DELETE FROM reportes WHERE dispositivo = ?").bind(dispositivo).run();
    return json({ ok: true, borrados: r.meta?.changes ?? 0 }, cors);
  }
  return json({ error: "No encontrado" }, cors, 404);
}

/* ---------- AVISOS AL TELÉFONO (app de las tiendas) ---------- */
// Cada teléfono guarda su token de Expo y si quiere aviso de mediodía (m) y/o noche (t)
async function avisos(request, env, cors) {
  if (!env.DB) return json({ error: "Sin base de datos" }, cors, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: "No entendí la petición." }, cors, 400); }
  const token = String(b?.token || "");
  if (!/^Expo(nent)?PushToken\[[\w-]{10,}\]$/.test(token)) return json({ error: "Token no válido." }, cors, 400);
  const m = b.m ? 1 : 0, tt = b.t ? 1 : 0, plataforma = ["ios", "android"].includes(b.plataforma) ? b.plataforma : "?";
  if (!m && !tt) {
    await env.DB.prepare("DELETE FROM avisos WHERE token = ?").bind(token).run();
    return json({ ok: true, m: false, t: false }, cors);
  }
  const ahora = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO avisos (token, m, t, plataforma, creado, actualizado) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (token) DO UPDATE SET m = excluded.m, t = excluded.t, plataforma = excluded.plataforma, actualizado = excluded.actualizado`)
    .bind(token, m, tt, plataforma, ahora, ahora).run();
  return json({ ok: true, m: !!m, t: !!tt }, cors);
}

// Cada minuto cerca de los sorteos: si salió un número nuevo de hoy, avisar una sola vez
async function revisarYAvisar(env) {
  if (!env.DB) return;
  const datos = await leer();
  const hoy = fechaFlorida(0).iso, r3 = datos.sorteos[hoy] || [], r4 = (datos.pick4 || {})[hoy] || [];
  for (const [i, sorteo] of [[0, "M"], [1, "T"]]) {
    const n3 = r3[i];
    if (!n3) continue;
    // Marcar como enviado ANTES de mandar, para que dos ejecuciones no avisen dos veces
    const marca = await env.DB.prepare("INSERT OR IGNORE INTO enviados (fecha, sorteo, numero, creado) VALUES (?, ?, ?, ?)")
      .bind(hoy, sorteo, n3, new Date().toISOString()).run();
    if (!marca.meta?.changes) continue;
    const n4 = r4[i];
    const titulo = `${sorteo === "M" ? "☀ Mediodía" : "☾ Noche"} · Fijo ${n3.slice(1)}`;
    const cuerpo = `Pick 3: ${n3} · Centena ${n3[0]}` + (n4 ? ` · Corridos ${n4.slice(0, 2)} y ${n4.slice(2)}` : " · Los corridos salen en unos minutos");
    const { results } = await env.DB.prepare(`SELECT token FROM avisos WHERE ${sorteo === "M" ? "m" : "t"} = 1`).all();
    for (let j = 0; j < results.length; j += 100) {
      const lote = results.slice(j, j + 100).map(r => ({
        to: r.token, title: titulo, body: cuerpo, sound: "default", channelId: "resultados", priority: "high",
        data: { fecha: hoy, sorteo },
      }));
      try {
        const resp = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(lote),
        });
        const j2 = await resp.json().catch(() => ({}));
        // Borrar los teléfonos que ya no existen (app borrada)
        const muertos = (j2.data || []).map((d, k) => d?.details?.error === "DeviceNotRegistered" ? lote[k].to : null).filter(Boolean);
        for (const tk of muertos) await env.DB.prepare("DELETE FROM avisos WHERE token = ?").bind(tk).run();
      } catch (e) { /* se reintenta solo en el próximo sorteo */ }
    }
  }
}

export default {
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(revisarYAvisar(env));
  },
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method === "POST" && new URL(request.url).pathname === "/ia") {
      return preguntarIA(request, env, cors, json, leer, () => fechaFlorida(0).iso);
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/avisos") {
      try { return await avisos(request, env, cors); }
      catch (e) { return json({ error: "No se pudieron guardar los avisos." }, cors, 500); }
    }
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
