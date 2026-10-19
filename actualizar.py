"""Robot que baja los números del Pick 3 de Florida y los guarda en datos.json.

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

URL_OFICIAL = "https://files.floridalottery.com/exptkt/p3.pdf"
URL_USA = {
    "M": "https://www.lotteryusa.com/florida/midday-pick-3/year",
    "T": "https://www.lotteryusa.com/florida/pick-3/year",
}
URL_NET = "https://www.lottery.net/florida/pick-3/numbers/{:%m-%d-%Y}"


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


def oficial():
    """{fecha: {"M": "123", "T": "456"}} desde el PDF oficial."""
    pdftotext = shutil.which("pdftotext")
    if not pdftotext:
        print("  oficial: falta pdftotext, se salta")
        return {}
    with tempfile.TemporaryDirectory() as tmp:
        pdf, txt = os.path.join(tmp, "p3.pdf"), os.path.join(tmp, "p3.txt")
        with open(pdf, "wb") as f:
            f.write(bajar(URL_OFICIAL))
        subprocess.run([pdftotext, "-layout", pdf, txt], check=True)
        texto = open(txt, encoding="utf-8", errors="ignore").read()
    res = {}
    for mes, dia, anio, k, a, b, c in re.findall(r"(\d\d)/(\d\d)/(\d\d)\s+([EM])\s+(\d)-\s*(\d)\s*-\s*(\d)", texto):
        # El historial empieza en 1988: "99" es 1999, no 2099
        anio = int(anio) + (1900 if int(anio) >= 80 else 2000)
        fecha = dt.date(anio, int(mes), int(dia))
        if fecha >= DESDE:
            res.setdefault(fecha.isoformat(), {})["M" if k == "M" else "T"] = a + b + c
    return res


def lotteryusa():
    res = {}
    for k, url in URL_USA.items():
        s = bajar(url).decode("utf-8", errors="ignore")
        m = re.search(r'data-exportMenu-csv-value="([^"]*)"', s)
        if not m:
            raise ValueError("LotteryUSA cambió su página (" + k + ")")
        for linea in html.unescape(m.group(1)).strip().split("\n")[1:]:
            x = re.match(r'"\w+, (\w+) (\d+), (\d+)","(\d), (\d), (\d)"', linea)
            if x:
                fecha = dt.datetime.strptime(f"{x[1]} {x[2]} {x[3]}", "%b %d %Y").date().isoformat()
                res.setdefault(fecha, {})[k] = x[4] + x[5] + x[6]
    return res


def lotterynet(dias=3):
    res = {}
    hoy = dt.datetime.now(dt.timezone.utc).date()
    for i in range(dias):
        fecha = hoy - dt.timedelta(days=i)
        try:
            s = bajar(URL_NET.format(fecha)).decode("utf-8", errors="ignore")
        except Exception as e:
            print("  lottery.net", fecha, "falló:", e)
            continue
        texto = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))
        for nombre, k in (("Midday", "M"), ("Evening", "T")):
            x = re.search(nombre + r" \d+:\d+ [AP]M (\d) (\d) (\d) (\d)\b", texto)
            if x:
                res.setdefault(fecha.isoformat(), {})[k] = x[1] + x[2] + x[3]
    return res


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        viejo = json.load(open(ARCHIVO, encoding="utf-8"))
    except FileNotFoundError:
        viejo = {"sorteos": {}}
    sorteos = {f: list(v) for f, v in viejo["sorteos"].items()}

    fuentes = []
    try:
        fuentes.append(("LotteryUSA", lotteryusa()))
    except Exception as e:
        print("  LotteryUSA falló:", e)
        fuentes.append(("Lottery.net", lotterynet()))
    try:
        fuentes.append(("Oficial", oficial()))  # la última manda
    except Exception as e:
        print("  oficial falló:", e)

    for nombre, datos in fuentes:
        print(f"  {nombre}: {len(datos)} días")
        for fecha, v in datos.items():
            if fecha < DESDE.isoformat():
                continue
            fila = sorteos.setdefault(fecha, [None, None])
            for i, k in enumerate(("M", "T")):
                n = v.get(k)
                if n and re.fullmatch(r"\d{3}", n):
                    if fila[i] and fila[i] != n:
                        print(f"  {nombre} corrige {fecha} {k}: {fila[i]} -> {n}")
                    fila[i] = n

    # Fuera las fechas imposibles (antes del inicio o en el futuro)
    manana = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).date().isoformat()
    sorteos = {f: v for f, v in sorted(sorteos.items()) if DESDE.isoformat() <= f <= manana and (v[0] or v[1])}
    cambio = sorteos != viejo["sorteos"]
    if cambio:
        nuevo = {
            "actualizado": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "desde": DESDE.isoformat(),
            "sorteos": sorteos,
        }
        with open(ARCHIVO, "w", encoding="utf-8") as f:
            json.dump(nuevo, f, separators=(",", ":"))
            f.write("\n")
    ultimo = max(sorteos) if sorteos else "-"
    print(f"Días guardados: {len(sorteos)} · último: {ultimo} {sorteos.get(ultimo)} · cambió: {'sí' if cambio else 'no'}")

    salida = os.environ.get("GITHUB_OUTPUT")
    if salida:
        with open(salida, "a") as f:
            f.write(f"cambio={'true' if cambio else 'false'}\n")
    if not sorteos:
        sys.exit("No se pudo bajar ningún número")


if __name__ == "__main__":
    main()
