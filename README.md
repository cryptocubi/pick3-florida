# Pick 3 Florida · fijos diarios

App para el celular con los fijos (las dos últimas cifras) del Pick 3 de Florida, mañana y tarde,
en un calendario de lunes a domingo, desde el 1 de enero de 2021. Las líneas (00–09, 10–19…) que se
repiten en la semana salen del mismo color, y el mismo fijo repetido sale con borde.

- `index.html`: la app.
- `datos.json`: los números (`"AAAA-MM-DD": ["mañana", "tarde"]`).
- `actualizar.py`: el robot que baja los números (historial oficial de la Lotería de Florida + LotteryUSA el mismo día; Lottery.net si LotteryUSA falla).
- `.github/workflows/actualizar.yml`: GitHub corre el robot unos minutos después de cada sorteo y vuelve a publicar la app.

Para probarlo en la PC: `python actualizar.py` y abrir la carpeta con un servidor local (`python -m http.server`).

## En vivo

`vivo/worker.js` es un Cloudflare Worker (`pick3-vivo`) que lee LotteryUSA (y Lottery.net si hace falta)
en el momento y se lo da a la app con permiso CORS. La app lo mira cada 30 segundos cerca de cada sorteo
(1:25–2:45 pm y 9:40–11:00 pm, hora de Florida) y cada 5 minutos el resto del tiempo. Para volver a
publicarlo: `cd vivo` y `npx wrangler deploy`.
