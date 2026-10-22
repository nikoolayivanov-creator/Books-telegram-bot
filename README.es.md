# flibusta-telegram-bot

[RU](README.md) · [EN](README.en.md) · [中文](README.zh.md) · **Español** · [Français](README.fr.md)

Bot de Telegram para buscar y descargar libros de [Flibusta](https://flibusta.is).

El LLM hace aquí una sola cosa: convertir una consulta en lenguaje libre en una estructura «autor + título» para que la búsqueda OPDS de Flibusta dé en el blanco. La búsqueda, la ordenación y la descarga son deterministas y funcionan sin LLM. En paralelo al análisis del LLM corre un barrido determinista de divisiones: los dos conjuntos de candidatos se combinan y cada libro entra en los resultados con la mejor de las dos puntuaciones.

## Funcionalidades

- Búsqueda en lenguaje libre («conan doyle sherlock», «wite fang london»): el LLM extrae el autor y el título, y el barrido de divisiones lo cubre en paralelo.
- Lista ordenada con formatos, tamaño, número de descargas y traductor; 3 páginas de 5 libros.
- Ficha del libro con descripción y botones de formato (fb2, epub, mobi, pdf, txt, rtf, html).
- Descarga con descompresión: Flibusta entrega los formatos de texto dentro de un zip, y el bot extrae el archivo interno para que la aplicación de lectura lo abra.
- Transmisión del proceso de búsqueda al chat: «analizando», «buscando», «pasando página 3/10», «comparando». El usuario ve qué hace el bot en lugar de esperar en silencio.
- Límites diarios en una ventana móvil de 24 h: 10 descargas, 50 búsquedas, más una lista de IDs sin límite.
- Analítica en SQLite (`/stats`), caché de búsqueda en memoria durante 6 horas.
- Registro de consultas y libros elegidos en JSONL (el id de telegram se hashea con sha256) — para analizar por tu cuenta la calidad de la búsqueda.

## Cómo se usa el LLM

En cada búsqueda sin caché hay una sola llamada a `parseQuery`, que convierte el texto en `{authors, title, series, genre}`. Después, el LLM no interviene.

La búsqueda va por dos caminos a la vez:

1. **Análisis del LLM**: la estructura de `parseQuery` entra en la búsqueda OPDS de Flibusta por autor y título.
2. **Barrido determinista de divisiones** (`splitSearchBooks`): la consulta se parte en variantes «autor + título» y cada una se comprueba con una búsqueda, sin LLM.

Los conjuntos de candidatos se combinan, cada libro se puntúa según ambos análisis y se toma el máximo. El barrido cubre los casos donde el LLM falla (búsqueda solo por autor, consultas reales sucias) y sostiene el bot si el proveedor cae: cuando el LLM no está disponible, la búsqueda pasa a modo degradado (la consulta entera como título) y el barrido sigue funcionando igual. El reasoning del LLM está desactivado por velocidad; las consultas en caché no hacen ni una sola llamada.

Medición sobre 200 consultas (100 libros, cada uno con una formulación limpia y otra sucia): la unión del LLM y el barrido da un 80 % de aciertos exactos en el top-3 con las limpias y un 75 % con las sucias; sin LLM, la búsqueda de consultas sucias cae al 17 % — el barrido no sabe sacar el autor y el título de una frase con erratas y ruido.

## Requisitos

- Node 20 (lo más fácil es con Docker).
- Token de bot de Telegram de @BotFather.
- Clave de API de un proveedor LLM compatible con OpenAI (bothub.chat, OpenAI, etc.).
- Un servidor o VPS con Docker.

## Configuración

```bash
cp .env.example .env
```

| Variable | Oblig. | Por defecto | Descripción |
|---|---|---|---|
| `BOT_TOKEN` | sí | - | token de @BotFather |
| `ADMIN_IDS` | sí | - | IDs de Telegram de los administradores, separados por comas; ven `/stats` |
| `LLM_API_KEY` | sí | - | clave del proveedor LLM |
| `LLM_BASE` | sí | - | endpoint compatible con OpenAI, p. ej. `https://openai.bothub.chat/v1` |
| `MODEL` | sí | - | modelo, p. ej. `gemini-2.5-flash` |
| `FLIBUSTA_BASE` | sí | - | espejo de Flibusta, p. ej. `https://flibusta.is` |
| `FLIBUSTA_FALLBACK_BASE` | no | - | espejo de reserva |
| `ALLOWED_IDS` | no | (vacío) | whitelist; vacío significa que el bot es público |
| `UNLIMITED_IDS` | no | - | IDs sin límites diarios |
| `DOWNLOAD_DAILY_LIMIT` | no | 10 | descargas por 24 h |
| `SEARCH_DAILY_LIMIT` | no | 50 | búsquedas por 24 h |
| `RATE_LIMIT_PER_MIN` | no | 20 | peticiones por minuto y usuario |
| `MAX_QUERY_LEN` | no | 100 | longitud máxima de la consulta, en caracteres |
| `SEARCH_CACHE_TTL_SEC` | no | 21600 | TTL de la caché de búsqueda |
| `SEARCH_CACHE_MAX` | no | 2000 | entradas en la caché de búsqueda |
| `USAGE_LOG_PATH` | no | `/logs/usage.jsonl` | ruta al registro de consultas y selecciones (el id se hashea) |
| `LOG_TTL_DAYS` | no | - | días de retención de eventos en SQLite |

## Ejecución (Docker)

```bash
docker compose up -d --build
docker compose logs -f
```

## Despliegue en un VPS

En `deploy.sh` indica `VPS=user@host`, y después:

```bash
./deploy.sh
```

El script sincroniza el código por ssh, construye la imagen y reinicia el contenedor.

## Desarrollo

```bash
npm install
npm test
npm run build && npm start
```

## Arquitectura

- `bot.ts` — manejadores de grammY sobre long polling, sin bloqueo: el trabajo pesado pasa a segundo plano y la cola de actualizaciones no se acumula. Aquí vive también la lógica de transmisión: los eventos de progreso se condensan en textos de estado con throttle, para no saturar el chat.
- `search/orchestrator.ts` — el núcleo de búsqueda: caché → análisis LLM → fusión del conjunto LLM y del barrido de divisiones → orden determinista → top-N. La ordenación puntúa la coincidencia de título y autor, con fuzzy matching de erratas por Levenshtein; a igual puntuación, gana la edición más popular.
- `search/llm.ts` — cliente LLM (compatible con OpenAI) con un único método, `parseQuery`.
- `search/flibusta.ts` — un envoltorio del paquete npm `flibusta`: búsqueda OPDS, paginación de la bibliografía del autor (los autores prolíficos no caben en la primera página), elección entre autores homónimos por popularidad, timeout en cada llamada de red.
- `download.ts` — descarga a tmpfs y descompresión de la capa zip.
- `status.ts` — textos de los mensajes de estado: fases de la búsqueda, progreso de la descarga.
- `usage-log.ts` — registro en JSONL de consultas y libros elegidos (el id de telegram se hashea con sha256, el contenido no se guarda).
- `db.ts` y `analytics.ts` — el diario de eventos en SQLite y los límites diarios.

## Aspectos legales

Los libros de Flibusta tienen distinto estatus de derechos de autor según la jurisdicción. Comprueba que tienes derecho a descargar el contenido en la tuya. El proveedor LLM y el modelo se configuran, así que respeta las condiciones de uso del proveedor que elijas.

## Licencia

MIT © vonavikon
