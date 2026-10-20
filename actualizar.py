"""Robot que baja los números del Pick 3 y del Pick 4 de Florida y los guarda en datos.json.

Pick 3 = fijo (sus dos últimas cifras) y centena (la primera).
Pick 4 = corridos (sus dos parejas de cifras).

Fuentes:
  1. Historial oficial de la Lotería de Florida (PDF, se renueva una vez al día por la mañana).
  2. LotteryUSA (mañana y tarde, salen minutos después de cada sorteo).
  3. Lottery.net, solo si LotteryUSA falla.
Si dos fuentes no coinciden, manda la oficial.

Uso:  python actualizar.py
"""
import datetime as dt
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

DESDE = dt.date(2021, 1, 1)
ARCHIVO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "datos.json")
NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# clave en datos.json -> cómo se baja cada juego
JUEGOS = {
    "sorteos": {
        "cifras": 3,
        "oficial": "https://files.floridalottery.com/exptkt/p3.pdf",
        "usa": {"M": "https://www.lotteryusa.com/florida/midday-pick-3/year",
                "T": "https://www.lotteryusa.com/florida/pick-3/year"},
        "net": "https://www.lottery.net/florida/pick-3/numbers/{:%m-%d-%Y}",
    },
    "pick4": {
        "cifras": 4,
        "oficial": "https://files.floridalottery.com/exptkt/p4.pdf",
        "usa": {"M": "https://www.lotteryusa.com/florida/midday-pick-4/year",
                "T": "https://www.lotteryusa.com/florida/pick-4/year"},
        "net": "https://www.lottery.net/florida/pick-4/numbers/{:%m-%d-%Y}",
    },
}


def bajar(url):
    # curl primero: el servidor oficial rechaza el cifrado que trae Python en Windows
    curl = shutil.which("curl")
    if curl:
        r = subprocess.run([curl, "-sfL", "--max-time", "60", "-A", NAVEGADOR, url], capture_output=True)
        if r.returncode != 0:
            raise OSError(f"curl {r.returncode} en {url}")
        return r.stdout
    pedido = urllib.request.Request(url, headers={"User-Agent": NAVEGADOR})
    with urllib.request.urlopen(pedido, timeout=60) as r:
        return r.read()


def oficial(juego):
    """{fecha: {"M": "123", "T": "456"}} desde el PDF oficial."""
    pdftotext = shutil.which("pdftotext")
    if not pdftotext:
        print("  oficial: falta pdftotext, se salta")
        return {}
    with tempfile.TemporaryDirectory() as tmp:
        pdf, txt = os.path.join(tmp, "juego.pdf"), os.path.join(tmp, "juego.txt")
        with open(pdf, "wb") as f:
            f.write(bajar(juego["oficial"]))
        subprocess.run([pdftotext, "-layout", pdf, txt], check=True)
        texto = open(txt, encoding="utf-8", errors="ignore").read()
    cifras = r"\s*-\s*".join([r"(\d)"] * juego["cifras"])
    res = {}
    for x in re.findall(r"(\d\d)/(\d\d)/(\d\d)\s+([EM])\s+" + cifras, texto):
        mes, dia, anio, k = x[:4]
        # El historial empieza en 1988: "99" es 1999, no 2099
        anio = int(anio) + (1900 if int(anio) >= 80 else 2000)
        fecha = dt.date(anio, int(mes), int(dia))
        res.setdefault(fecha.isoformat(), {})["M" if k == "M" else "T"] = "".join(x[4:])
    return res  # todo el historial (desde 1988); juntar() se queda con lo de DESDE


def guardar_historico(oficial_p3, recientes):
    """historico.json: el Pick 3 completo de cada sorteo, un código de 3 cifras por día ("---" si no hubo)."""
    todos = {f: dict(v) for f, v in oficial_p3.items()}
    for f, (m, t) in recientes.items():  # lo más nuevo que aún no está en el PDF
        if m: todos.setdefault(f, {})["M"] = m
        if t: todos.setdefault(f, {})["T"] = t
    salida = {}
    for k in ("M", "T"):
        fechas = sorted(f for f, v in todos.items() if k in v)
        if not fechas:
            continue
        d, fin, codigos = dt.date.fromisoformat(fechas[0]), dt.date.fromisoformat(fechas[-1]), []
        while d <= fin:
            codigos.append(todos.get(d.isoformat(), {}).get(k, "---"))
            d += dt.timedelta(days=1)
        salida[k] = {"desde": fechas[0], "n": "".join(codigos)}
    ruta = os.path.join(os.path.dirname(ARCHIVO), "historico.json")
    try:
        viejo = json.load(open(ruta, encoding="utf-8"))
    except FileNotFoundError:
        viejo = None
    if salida and salida != viejo:
        with open(ruta, "w", encoding="utf-8", newline="\n") as f:
            json.dump(salida, f, separators=(",", ":"))
            f.write("\n")
        return True
    return False


def lotteryusa(juego):
    res = {}
    cifras = ", ".join([r"(\d)"] * juego["cifras"])
    for k, url in juego["usa"].items():
        s = bajar(url).decode("utf-8", errors="ignore")
        m = re.search(r'data-exportMenu-csv-value="([^"]*)"', s)
        if not m:
            raise ValueError("LotteryUSA cambió su página (" + k + ")")
        for linea in html.unescape(m.group(1)).strip().split("\n")[1:]:
            x = re.match(r'"\w+, (\w+) (\d+), (\d+)","' + cifras + '"', linea)
            if x:
                fecha = dt.datetime.strptime(f"{x[1]} {x[2]} {x[3]}", "%b %d %Y").date().isoformat()
                res.setdefault(fecha, {})[k] = "".join(x.groups()[3:])
    return res


def lotterynet(juego, dias=3):
    res = {}
    hoy = dt.datetime.now(dt.timezone.utc).date()
    cifras = " ".join([r"(\d)"] * (juego["cifras"] + 1))  # + Fireball
    for i in range(dias):
        fecha = hoy - dt.timedelta(days=i)
        try:
            s = bajar(juego["net"].format(fecha)).decode("utf-8", errors="ignore")
        except Exception as e:
            print("  lottery.net", fecha, "falló:", e)
            continue
        texto = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))
        for nombre, k in (("Midday", "M"), ("Evening", "T")):
            x = re.search(nombre + r" \d+:\d+ [AP]M " + cifras + r"\b", texto)
            if x:
                res.setdefault(fecha.isoformat(), {})[k] = "".join(x.groups()[:juego["cifras"]])
    return res


def juntar(clave, juego, viejos, completo):
    sorteos = {f: list(v) for f, v in viejos.items()}
    fuentes = []
    try:
        fuentes.append(("LotteryUSA", lotteryusa(juego)))
    except Exception as e:
        print("  LotteryUSA falló:", e)
        fuentes.append(("Lottery.net", lotterynet(juego)))
    try:
        todo = oficial(juego)
        completo[clave] = todo
        fuentes.append(("Oficial", {f: v for f, v in todo.items() if f >= DESDE.isoformat()}))  # la última manda
    except Exception as e:
        print("  oficial falló:", e)

    patron = r"\d{%d}" % juego["cifras"]
    for nombre, datos in fuentes:
        print(f"  {clave} · {nombre}: {len(datos)} días")
        for fecha, v in datos.items():
            if fecha < DESDE.isoformat():
                continue
            fila = sorteos.setdefault(fecha, [None, None])
            for i, k in enumerate(("M", "T")):
                n = v.get(k)
                if n and re.fullmatch(patron, n):
                    if fila[i] and fila[i] != n:
                        print(f"  {nombre} corrige {clave} {fecha} {k}: {fila[i]} -> {n}")
                    fila[i] = n

    # Fuera las fechas imposibles (antes del inicio o en el futuro)
    manana = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).date().isoformat()
    return {f: v for f, v in sorted(sorteos.items()) if DESDE.isoformat() <= f <= manana and (v[0] or v[1])}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        viejo = json.load(open(ARCHIVO, encoding="utf-8"))
    except FileNotFoundError:
        viejo = {}

    completo = {}
    nuevo = {clave: juntar(clave, juego, viejo.get(clave, {}), completo) for clave, juego in JUEGOS.items()}
    cambio = any(nuevo[c] != viejo.get(c) for c in JUEGOS)
    if "sorteos" in completo and guardar_historico(completo["sorteos"], nuevo["sorteos"]):
        print("historico.json actualizado")
        cambio = True
    if cambio:
        salida = {
            "actualizado": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "desde": DESDE.isoformat(),
            **nuevo,
        }
        with open(ARCHIVO, "w", encoding="utf-8", newline="\n") as f:
            json.dump(salida, f, separators=(",", ":"))
            f.write("\n")
    for clave in JUEGOS:
        s = nuevo[clave]
        ultimo = max(s) if s else "-"
        print(f"{clave}: {len(s)} días · último: {ultimo} {s.get(ultimo)}")
    print("Cambió:", "sí" if cambio else "no")

    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a") as f:
            f.write(f"cambio={'true' if cambio else 'false'}\n")
    if not nuevo["sorteos"]:
        sys.exit("No se pudo bajar ningún número")


if __name__ == "__main__":
    main()
