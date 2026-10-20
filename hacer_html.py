"""Crea un solo archivo HTML con la app y los números ya dentro.

Se abre con doble clic. Con internet se pone al día solo (historial de GitHub
y puente en vivo); sin internet muestra los números que trae dentro.

Uso:  python hacer_html.py RUTA_DEL_HTML
"""
import json
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
WEB = "https://cryptocubi.github.io/pick3-florida/"

html = open(os.path.join(AQUI, "index.html"), encoding="utf-8").read()
datos = json.load(open(os.path.join(AQUI, "datos.json"), encoding="utf-8"))

cambios = [
    # cosas que solo sirven para la app instalada
    ('<link rel="manifest" href="manifest.webmanifest">\n', ""),
    ('<link rel="icon" href="icono-192.png" type="image/png">\n', ""),
    ('<link rel="apple-touch-icon" href="icono-180.png">\n', ""),
    ('if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});\n', ""),
    # el historial se pide a la app publicada
    ('fetch("datos.json" + (forzar ? "?t=" + Date.now() : ""), { cache: "no-store" })',
     f'fetch("{WEB}datos.json?t=" + Date.now(), {{ cache: "no-store" }})'),
    # arranca con los números que trae dentro
    ("cargar(false);\nvigilar();",
     "const INICIAL = " + json.dumps(datos, separators=(",", ":")) + ";\n"
     "BASE = INICIAL.sorteos; ACTUALIZADO = INICIAL.actualizado; aplicar();\n"
     "cargar(true);\nvigilar();"),
]
for viejo, nuevo in cambios:
    if viejo not in html:
        sys.exit("No encontré en index.html: " + viejo[:60])
    html = html.replace(viejo, nuevo)

destino = sys.argv[1] if len(sys.argv) > 1 else os.path.join(AQUI, "pick3-florida.html")
with open(destino, "w", encoding="utf-8") as f:
    f.write(html)
print("Creado", destino, "·", len(datos["sorteos"]), "días · último", max(datos["sorteos"]))
