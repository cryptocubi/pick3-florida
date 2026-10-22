// Asistente con Claude (Anthropic) para la app Pick 3.
// Contesta preguntas sobre los resultados con el historial completo (noche desde 1988, mediodía desde 2008)
// y unas herramientas para consultarlo. No guarda las preguntas: solo cuenta cuántas hace cada teléfono.
import Anthropic from "@anthropic-ai/sdk";

const MODELO = "claude-opus-5-5";
const WEB = "https://cryptocubi.github.io/pick3-florida/";
const LIMITE_TELEFONO = 15;   // preguntas por teléfono y día
const LIMITE_TOTAL = 400;     // preguntas al día entre todos (tope de gasto)
const MAX_VUELTAS = 5;        // máximo de rondas de herramientas por pregunta

// Significado principal de cada número en la charada cubana (00 = 100)
const CHARADA = ["Inodoro", "Caballo", "Mariposa", "Marinero", "Gato", "Monja", "Jicotea", "Caracol", "Muerto", "Elefante",
  "Pescado grande", "Gallo", "Mujer santa", "Pavo real", "Gato tigre", "Perro", "Toro", "Luna", "Pescado chiquito", "Lombriz",
  "Gato fino", "Majá", "Sapo", "Vapor", "Paloma", "Piedra fina", "Anguila", "Avispa", "Chivo", "Ratón",
  "Camarón", "Venado", "Cochino", "Tiñosa", "Mono", "Araña", "Cachimba", "Gallina prieta", "Dinero", "Conejo",
  "Cura", "Lagartija", "Pato", "Alacrán", "Año del cuero", "Tiburón", "Guagua", "Pájaro", "Cucaracha", "Borracho",
  "Policía", "Soldado", "Bicicleta", "Luz eléctrica", "Flores", "Cangrejo", "Reina escorpión", "Cama", "Adulterio", "Loco",
  "Sol oscuro", "Cañonazo", "Matrimonio", "Asesino", "Muerto grande", "Cárcel", "Divorcio", "Puñalada", "Cementerio", "Pozo",
  "Teléfono", "Río", "Ferrocarril", "Parque", "Papalote", "Cine", "Bailarina", "Banderas", "Obispo", "Coche",
  "Médico", "Teatro", "Madre", "Tragedia", "Ciego", "Reloj", "Convento", "Nueva York", "Espejuelos", "Lotería",
  "Viejo", "Tranvía", "Puerco gordo", "Revolución", "Machete", "Guerra", "Desafío", "Mosquito grande", "Piano", "Serrucho"];

/* ---------- Datos ---------- */
let CACHE = null; // { cuando, M: [{f, n}], T: [{f, n}], p4: {fecha: [m, t]} }

async function cargarDatos(leerVivo) {
  if (CACHE && Date.now() - CACHE.cuando < 10 * 60e3) return CACHE;
  const [h, d, vivo] = await Promise.all([
    fetch(WEB + "historico.json", { cf: { cacheTtl: 600 } }).then(r => r.json()),
    fetch(WEB + "datos.json", { cf: { cacheTtl: 300 } }).then(r => r.json()),
    leerVivo().catch(() => ({ sorteos: {}, pick4: {} })),
  ]);
  const serie = k => {
    const out = [], base = Date.parse(h[k].desde + "T00:00:00Z"), n = h[k].n;
    for (let j = 0; j * 3 < n.length; j++) {
      const c = n.substr(j * 3, 3);
      if (c !== "---") out.push({ f: new Date(base + j * 864e5).toISOString().slice(0, 10), n: c });
    }
    return out;
  };
  const M = serie("M"), T = serie("T");
  // Lo en vivo (de hoy) que todavía no está en el historial
  for (const [f, [m, t]] of Object.entries({ ...d.sorteos, ...vivo.sorteos })) {
    if (m && (!M.length || f > M[M.length - 1].f)) M.push({ f, n: m });
    if (t && (!T.length || f > T[T.length - 1].f)) T.push({ f, n: t });
  }
  M.sort((a, b) => a.f.localeCompare(b.f)); T.sort((a, b) => a.f.localeCompare(b.f));
  CACHE = { cuando: Date.now(), M, T, p4: { ...d.pick4, ...vivo.pick4 } };
  return CACHE;
}

const dias = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const nombreS = k => (k === "M" ? "mediodía" : "noche");

function resumenParaSistema(D, hoy) {
  const ultimos = [];
  const porFecha = {};
  for (const k of ["M", "T"]) for (const t of D[k].slice(-14)) (porFecha[t.f] ??= {})[k] = t.n;
  for (const f of Object.keys(porFecha).sort().slice(-14)) {
    const p4 = D.p4[f] || [];
    ultimos.push(`${f}: mediodía ${porFecha[f].M ?? "—"}${p4[0] ? ` (corridos ${p4[0].slice(0, 2)} ${p4[0].slice(2)})` : ""} · noche ${porFecha[f].T ?? "—"}${p4[1] ? ` (corridos ${p4[1].slice(0, 2)} ${p4[1].slice(2)})` : ""}`);
  }
  const atrasados = k => {
    const ult = {};
    for (const t of D[k]) ult[t.n.slice(1)] = t.f;
    return Object.entries(ult).map(([n, f]) => [n, dias(f, hoy)]).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([n, d]) => `${n} (${d} días)`).join(", ");
  };
  return `HOY (hora de Florida): ${hoy}.
ÚLTIMOS 14 DÍAS (Pick 3; el fijo son sus dos últimas cifras, la centena la primera; corridos = parejas del Pick 4):
${ultimos.join("\n")}
FIJOS MÁS ATRASADOS – mediodía: ${atrasados("M")}
FIJOS MÁS ATRASADOS – noche: ${atrasados("T")}
HISTORIAL DISPONIBLE: mediodía desde ${D.M[0].f} (${D.M.length} sorteos), noche desde ${D.T[0].f} (${D.T.length} sorteos).`;
}

/* ---------- Herramientas ---------- */
const HERRAMIENTAS = [
  {
    name: "estadistica_fijo",
    description: "Datos de un fijo (dos cifras, 00-99) en todo el historial: veces que salió, última fecha, días sin salir y cada cuántos días sale de media. Úsala para preguntas sobre un número concreto.",
    input_schema: {
      type: "object",
      properties: {
        fijo: { type: "string", description: "Dos cifras, por ejemplo \"07\"" },
        sorteo: { type: "string", enum: ["M", "T", "ambos"], description: "M = mediodía, T = noche" },
      },
      required: ["fijo", "sorteo"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "despues_de",
    description: "Qué salió en un sorteo posterior cada vez que un fijo salió en un sorteo dado. Por ejemplo: cuando salió el 27 al mediodía, qué fijo y qué línea salió esa misma noche. Devuelve cuántas veces pasó, los fijos y líneas que más se repitieron y los últimos casos.",
    input_schema: {
      type: "object",
      properties: {
        fijo: { type: "string", description: "Fijo de dos cifras que salió primero" },
        en: { type: "string", enum: ["M", "T"], description: "Sorteo donde salió ese fijo" },
        mirar: { type: "string", enum: ["misma_noche", "dia_siguiente_mediodia", "dia_siguiente_noche"], description: "Qué sorteo mirar después" },
      },
      required: ["fijo", "en", "mirar"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "sorteos_entre",
    description: "Lista de resultados (Pick 3 y corridos) entre dos fechas, máximo 62 días. Úsala para preguntas sobre semanas o meses concretos.",
    input_schema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "AAAA-MM-DD" },
        hasta: { type: "string", description: "AAAA-MM-DD" },
      },
      required: ["desde", "hasta"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "frecuencia_lineas",
    description: "Cuántas veces salió cada línea (00-09, 10-19, ..., 90-99), cada centena o cada terminal en los últimos N días, para mediodía, noche o ambos.",
    input_schema: {
      type: "object",
      properties: {
        que: { type: "string", enum: ["lineas", "centenas", "terminales"] },
        sorteo: { type: "string", enum: ["M", "T", "ambos"] },
        ultimos_dias: { type: "integer", description: "Entre 7 y 10000" },
      },
      required: ["que", "sorteo", "ultimos_dias"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function usarHerramienta(D, hoy, nombre, e) {
  const series = s => (s === "ambos" ? [...D.M.map(t => ({ ...t, k: "M" })), ...D.T.map(t => ({ ...t, k: "T" }))] : D[s].map(t => ({ ...t, k: s })));
  if (nombre === "estadistica_fijo") {
    const fijo = String(e.fijo ?? "").padStart(2, "0").slice(-2);
    if (!/^\d\d$/.test(fijo)) return { error: "fijo no válido" };
    const lista = series(e.sorteo).filter(t => t.n.slice(1) === fijo).sort((a, b) => a.f.localeCompare(b.f));
    const total = series(e.sorteo).length;
    const ult = lista.at(-1);
    return {
      fijo, charada: CHARADA[+fijo], sorteo: e.sorteo, veces: lista.length, de_sorteos: total,
      porcentaje: +(100 * lista.length / Math.max(1, total)).toFixed(2), esperado_por_azar: "1 %",
      ultima_vez: ult ? `${ult.f} (${nombreS(ult.k)})` : null, dias_sin_salir: ult ? dias(ult.f, hoy) : null,
      sale_cada_dias_de_media: lista.length > 1 ? Math.round(dias(lista[0].f, lista.at(-1).f) / (lista.length - 1)) : null,
      ultimos_365_dias: lista.filter(t => dias(t.f, hoy) <= 365).length,
    };
  }
  if (nombre === "despues_de") {
    const fijo = String(e.fijo ?? "").padStart(2, "0").slice(-2);
    const origen = Object.fromEntries(D[e.en].map(t => [t.f, t.n]));
    const destinoK = e.mirar === "dia_siguiente_mediodia" ? "M" : "T";
    const desplaz = e.mirar === "misma_noche" ? 0 : 1;
    if (e.mirar === "misma_noche" && e.en === "T") return { error: "Para la noche, mira el día siguiente" };
    const destino = Object.fromEntries(D[destinoK].map(t => [t.f, t.n]));
    const casos = [];
    for (const [f, n] of Object.entries(origen)) {
      if (n.slice(1) !== fijo) continue;
      const g = new Date(Date.parse(f) + desplaz * 864e5).toISOString().slice(0, 10);
      if (destino[g]) casos.push({ fecha: g, sale: destino[g] });
    }
    casos.sort((a, b) => a.fecha.localeCompare(b.fecha));
    const cuenta = (fn) => {
      const c = {};
      for (const x of casos) c[fn(x.sale)] = (c[fn(x.sale)] || 0) + 1;
      return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => ({ valor: v, veces: n }));
    };
    return {
      busqueda: `fijo ${fijo} en el ${nombreS(e.en)} → ${e.mirar.replace(/_/g, " ")}`, casos: casos.length,
      fijos_mas_repetidos: cuenta(s => s.slice(1)), lineas: cuenta(s => s[1] + "0-" + s[1] + "9"),
      ultimos_casos: casos.slice(-10), nota: "Con pocos casos, las repeticiones suelen ser casualidad: cada fijo tiene 1 % y cada línea 10 %.",
    };
  }
  if (nombre === "sorteos_entre") {
    let { desde, hasta } = e;
    if (!/^\d{4}-\d\d-\d\d$/.test(desde) || !/^\d{4}-\d\d-\d\d$/.test(hasta)) return { error: "fechas no válidas" };
    if (dias(desde, hasta) > 62) hasta = new Date(Date.parse(desde) + 62 * 864e5).toISOString().slice(0, 10);
    const filas = {};
    for (const k of ["M", "T"]) for (const t of D[k]) if (t.f >= desde && t.f <= hasta) (filas[t.f] ??= {})[k] = t.n;
    return Object.keys(filas).sort().map(f => ({ fecha: f, mediodia: filas[f].M ?? null, noche: filas[f].T ?? null, corridos: D.p4[f] ?? null }));
  }
  if (nombre === "frecuencia_lineas") {
    const nd = Math.max(7, Math.min(10000, e.ultimos_dias | 0));
    const desde = new Date(Date.parse(hoy) - nd * 864e5).toISOString().slice(0, 10);
    const lista = series(e.sorteo).filter(t => t.f > desde);
    const c = {};
    for (const t of lista) {
      const v = e.que === "lineas" ? t.n[1] + "0-" + t.n[1] + "9" : e.que === "centenas" ? t.n[0] : "x" + t.n[2];
      c[v] = (c[v] || 0) + 1;
    }
    return { que: e.que, sorteo: e.sorteo, sorteos: lista.length, esperado_cada_uno: +(lista.length / 10).toFixed(1), cuenta: Object.fromEntries(Object.entries(c).sort()) };
  }
  return { error: "herramienta desconocida" };
}

/* ---------- Instrucciones ---------- */
const INSTRUCCIONES = `Eres el asistente de la app "Pick 3" (resultados del Pick 3 y Pick 4 de Florida en español, para la comunidad cubana).
Hablas con gente sencilla que no sabe de estadística: responde SIEMPRE en español, con frases cortas, claras y cálidas. Nada de fórmulas ni palabras técnicas. Respuestas breves (máximo unas 120 palabras) salvo que pidan detalle.

Vocabulario: fijo = las dos últimas cifras del Pick 3; centena = la primera cifra; corridos = las dos parejas del Pick 4 del mismo sorteo; línea o decena = 00-09, 10-19…; terminal = última cifra; charada = significado tradicional cubano de cada número. Mediodía = 1:30 pm y noche = 9:45 pm, hora de Florida.

Usa las herramientas para mirar el historial antes de contestar preguntas sobre el pasado, y di de dónde sale cada dato (cuántas veces, desde qué año). Nunca inventes resultados: si no tienes el dato, dilo.

Honestidad (muy importante):
- Cada sorteo es al azar. Cualquier fijo tiene 1 de 100; una línea, 1 de 10. Que un número esté atrasado o haya salido mucho NO cambia la próxima vez. Dilo con naturalidad, sin sermones, cuando venga a cuento.
- Si piden "un número para hoy", puedes dar uno o tres como entretenimiento, explicando de qué patrón del historial salen, y recordando en una frase que no es una predicción.
- No prometas ganancias ni digas que un método funciona. No animes a apostar más ni a recuperar pérdidas. No ayudes a apostar con banqueros o "bolita" ilegal.
- Si alguien muestra problemas con el juego (deudas, angustia, perder el control), responde con cariño y da la línea gratuita 1-888-ADMIT-IT (1-888-236-4848), 24 horas.
- La app no es oficial; los resultados oficiales están en floridalottery.com.
Si te preguntan algo que no tiene que ver con la lotería, la charada o la app, contesta en una frase que solo ayudas con eso.`;

/* ---------- Petición ---------- */
async function huella(texto) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export async function preguntarIA(request, env, cors, json, leerVivo, hoyFlorida) {
  // Si al pegar la clave se perdió la "s" inicial (pasa con la ventana de "pulse una tecla"), se repone
  const clave = String(env.ANTHROPIC_API_KEY || "").trim().replace(/^k-ant-/, "sk-ant-");
  if (!clave) return json({ error: "La IA todavía no está activada. Vuelve pronto." }, cors, 503);
  if (!env.DB) return json({ error: "Sin base de datos" }, cors, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: "No entendí la pregunta." }, cors, 400); }
  const dispositivo = String(b?.dispositivo || "");
  if (!/^[a-z0-9]{16,40}$/.test(dispositivo)) return json({ error: "Falta el identificador del teléfono." }, cors, 400);
  // Solo texto, alternando persona/IA, empezando y terminando por la persona; se guardan las 10 últimas
  const mensajes = (Array.isArray(b.mensajes) ? b.mensajes : []).slice(-10)
    .filter(m => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, 1200) }));
  while (mensajes.length && mensajes[0].role !== "user") mensajes.shift();
  if (!mensajes.length || mensajes.at(-1).role !== "user") return json({ error: "Escribe tu pregunta." }, cors, 400);

  // Límites de uso (no se guarda el texto de las preguntas)
  const hoy = hoyFlorida();
  const yo = await huella(dispositivo + "|" + (env.SAL || "pick3"));
  const usoMio = await env.DB.prepare("SELECT n FROM uso_ia WHERE quien = ? AND fecha = ?").bind(yo, hoy).first();
  if ((usoMio?.n || 0) >= LIMITE_TELEFONO) return json({ error: `Ya hiciste ${LIMITE_TELEFONO} preguntas hoy. Mañana puedes seguir.` }, cors, 429);
  const usoTotal = await env.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM uso_ia WHERE fecha = ?").bind(hoy).first();
  if ((usoTotal?.n || 0) >= LIMITE_TOTAL) return json({ error: "La IA está muy ocupada hoy. Prueba mañana." }, cors, 429);
  await env.DB.prepare("INSERT INTO uso_ia (quien, fecha, n) VALUES (?, ?, 1) ON CONFLICT (quien, fecha) DO UPDATE SET n = n + 1").bind(yo, hoy).run();

  const D = await cargarDatos(leerVivo);
  const client = new Anthropic({ apiKey: clave, maxRetries: 1, timeout: 50_000 });
  const conversacion = [...mensajes];
  try {
    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      const r = await client.beta.messages.create({
        model: MODELO,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: [
          { type: "text", text: INSTRUCCIONES, cache_control: { type: "ephemeral" } },
          { type: "text", text: resumenParaSistema(D, hoy) },
        ],
        tools: HERRAMIENTAS,
        messages: conversacion,
      });
      if (r.stop_reason === "refusal") return json({ respuesta: "Esa pregunta no la puedo contestar. Pregúntame sobre los resultados, la charada o la app." }, cors);
      if (r.stop_reason === "tool_use") {
        conversacion.push({ role: "assistant", content: r.content });
        const resultados = r.content.filter(c => c.type === "tool_use").map(c => {
          let salida;
          try { salida = usarHerramienta(D, hoy, c.name, c.input || {}); } catch (err) { salida = { error: String(err?.message || err) }; }
          return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(salida) };
        });
        conversacion.push({ role: "user", content: resultados });
        continue;
      }
      const texto = r.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
      return json({ respuesta: texto || "No tengo una respuesta para eso.", quedan: LIMITE_TELEFONO - (usoMio?.n || 0) - 1 }, cors);
    }
    return json({ respuesta: "Esa pregunta necesita demasiadas búsquedas. Prueba a hacerla más concreta." }, cors);
  } catch (e) {
    console.log("IA error", e?.status, e?.error?.error?.type);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "La IA no está bien configurada todavía." }, cors, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Mucha gente preguntando a la vez. Prueba en un minuto." }, cors, 429);
    if (e instanceof Anthropic.APIError) return json({ error: "La IA no respondió. Prueba otra vez en un momento." }, cors, 502);
    return json({ error: "No se pudo conectar con la IA. Revisa la conexión." }, cors, 502);
  }
}

// Solo para pruebas
export { usarHerramienta as _usarHerramienta, cargarDatos as _cargarDatos, resumenParaSistema as _resumen };
