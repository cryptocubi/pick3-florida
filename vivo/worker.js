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

async function leer() {
  const fallos = [];
  const [sorteos, pick4] = await Promise.all(Object.entries(JUEGOS).map(([c, j]) => leerJuego(c, j, fallos)));
  return { hora: new Date().toISOString(), sorteos, pick4, ...(fallos.length ? { fallos } : {}) };
}

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
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
