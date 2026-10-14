# Guía de integración · Integration Guide

Mood Mates es un motor de emociones SVG + JavaScript nativo sin dependencias y sin compilación.
El anfitrión solo necesita cargar los scripts en orden y llamar `MoodMates.create`.

## Integración rápida

```html
<!-- Motor (orden fijo): geometría → renderizado → rasgos → efectos → datos emocionales → motor -->
<script src="src/core/geometry.js"></script>
<script src="src/core/render.js"></script>
<script src="src/core/features.js"></script>
<script src="src/core/fx.js"></script>
<script src="src/data/emotions.js"></script>
<script src="src/core/engine.js"></script>
<!-- Cargar personajes según sea necesario (al menos uno) -->
<script src="src/characters/nimbo.js"></script>

<div id="mate" style="width:200px;height:200px"></div>
<script>
  var mate = MoodMates.create(document.getElementById('mate'), {
    character: 'nimbo',
    emotion: '02',
    idle: true
  });
</script>
```

`site/i18n.js` y `site/app.js` pertenecen al shell de la galería de demostración; el anfitrión no los necesita.

## Protocolo de IA

La IA solo necesita generar un JSON y pasarlo a `handleAIMessage` (acepta objeto o string):

```js
mate.handleAIMessage('{"emotionId":"30","tips":"Pensando en la pregunta del usuario"}');
```

- `emotionId` desconocido, error de análisis JSON, campo faltante: dispara evento `error` y
  vuelve a la emoción de respaldo (`fallbackId`, por defecto `'02'`); nunca deja la pantalla en blanco;
- `tips` es un texto opcional que se entrega mediante el evento `tips` para que el anfitrión lo renderice.

### Regla de segmentación de emotionId (contrato externo, los números nunca se reordenan)

| Rango | Grupo | Comunes |
| --- | --- | --- |
| 00-09 | ciclo de vida | 00 dormir · 01 despertar · 02 espera · 03 curiosidad |
| 10-29 | reacciones emocionales | 10 feliz · 13 sorpresa · 14 tímido · 21 enfadado |
| 30-49 | estados de trabajo de IA | 30 pensar · 33 completado · 34 error · 38 rechazar · 40 buscar |
| 50+ | personalizado | registro en tiempo de ejecución |

## Parámetros de creación

| Parámetro | Por defecto | Descripción |
| --- | --- | --- |
| `character` | primer personaje registrado | ID del personaje: `nimbo` / `twinkle` |
| `emotion` | `'02'` | ID de emoción inicial |
| `color` / `eyeColor` | — | Color corporal / de ojos del tema (para instancias de equipo) |
| `eyeScale` | `1` | Escala de los ojos; para tamaños < 80px recomendar 1.5~1.8 |
| `idle` | `false` | Estrategia de espera: conmutación automática tras inactividad / dormir; pasar un objeto para personalizar tiempos y estados |
| `autostart` | `true` | `false` renderiza un solo fotograma estático (para miniaturas) |
| `lite` | sigue `autostart` | Modo ligero: desactiva partículas de efectos y zzz |
| `fallbackId` | `'02'` | Emoción de respaldo para IDs desconocidos |

## Eventos y métodos

```js
mate.on('change', e => {});         // Emoción cambiada { id, def, auto }
mate.on('tips',   e => {});         // Texto opcional de IA { text }
mate.on('error',  e => {});         // Error de protocolo { message, ... }

mate.setEmotion('21');              // Cambio directo
mate.setGaze(nx, ny);               // Mirada normalizada [-1,1]; el anfitrión escucha pointermove
mate.setStyle({ sketch: 1 });       // Modo boceto
mate.celebrate();                  // Celebración de clic: Nimbo sopla burbujas; Twinkle firma + cuerpo + confeti
mate.signature();                  // Solo la acción de firma (burbuja de nube / estallido estelar)
                                    // Devuelve false si el personaje no tiene acción de firma
mate.spin(3);                      // Girar y lanzar partículas (genérico)
mate.burst(24);                    // Confeti
mate.bounce();                     // Rebote
mate.startTour(ids, 2500);         // Recorrido automático / mate.stopTour()
mate.setActive(false);             // Detener fotogramas cuando está fuera de pantalla; true lo reanuda
mate.renderStatic();               // Renderizar un fotograma estático
mate.registerEmotion(raw);         // Registrar emoción personalizada en tiempo de ejecución (rango 50+)
mate.destroy();                    // Destruir instancia
```

## Múltiples instancias y rendimiento

- Todas las instancias comparten un único latido rAF; más instancias no multiplican el costo del bucle;
- Muro de miniaturas: `autostart: false` renderiza estático, al pasar el ratón `setActive(true)`,
  al salir `setActive(false)`;
- Usar IntersectionObserver para `setActive(false)` en instancias fuera de pantalla.

## Mascota de escritorio / Electron

- Parámetros de ventana: `transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true`,
  fondo transparente solo con el contenedor del personaje;
- Transparencia del ratón: `win.setIgnoreMouseEvents(true, { forwardMouseMove: true })`
  — el personaje aún recibe `setGaze`, el clic atraviesa al escritorio;
- Reenvío de mensajes de IA por IPC: `ipcRenderer.on('emotion', (_, msg) => mate.handleAIMessage(msg))`;
- Ventanas pequeñas (≤ 120px) recomendar `eyeScale: 1.5` + `lite: true`.

## Emociones personalizadas

```js
MoodMates.config.register({
  id: '50', name: 'Saludo', group: 'custom',
  pool: ['happy', 'wide'],        // Huecos de forma de ojo (comunes a todos los personajes)
  mouth: 'grin',                  // Hueco de forma de boca
  body: { color: '@soft' },       // Color con @token, se adapta a la paleta de cada personaje
  anims: [ { target: 'body', prop: 'rotate', type: 'sine', amp: 6, period: 900 } ]
});
```

El formato de configuración completo está en los comentarios de cabecera de `src/data/emotions.js`;
importar y exportar con `MoodMates.config.exportConfig()` / `importConfig(json)`.

--- rostro_animado/docs/INTEGRATION.md (原始)
# Guía de integración · Integration Guide

Mood Mates es un motor de emociones SVG + JavaScript nativo sin dependencias y sin compilación.
El anfitrión solo necesita cargar los scripts en orden y llamar `MoodMates.create`.

## Integración rápida

```html
<!-- Motor (orden fijo): geometría → renderizado → rasgos → efectos → datos emocionales → motor -->
<script src="src/core/geometry.js"></script>
<script src="src/core/render.js"></script>
<script src="src/core/features.js"></script>
<script src="src/core/fx.js"></script>
<script src="src/data/emotions.js"></script>
<script src="src/core/engine.js"></script>
<!-- Cargar personajes según sea necesario (al menos uno) -->
<script src="src/characters/nimbo.js"></script>

<div id="mate" style="width:200px;height:200px"></div>
<script>
  var mate = MoodMates.create(document.getElementById('mate'), {
    character: 'nimbo',
    emotion: '02',
    idle: true
  });
</script>
```

`site/i18n.js` y `site/app.js` pertenecen al shell de la galería de demostración; el anfitrión no los necesita.

## Protocolo de IA

La IA solo necesita generar un JSON y pasarlo a `handleAIMessage` (acepta objeto o string):

```js
mate.handleAIMessage('{"emotionId":"30","tips":"Pensando en la pregunta del usuario"}');
```

- `emotionId` desconocido, error de análisis JSON, campo faltante: dispara evento `error` y
  vuelve a la emoción de respaldo (`fallbackId`, por defecto `'02'`); nunca deja la pantalla en blanco;
- `tips` es un texto opcional que se entrega mediante el evento `tips` para que el anfitrión lo renderice.

### Regla de segmentación de emotionId (contrato externo, los números nunca se reordenan)

| Rango | Grupo | Comunes |
| --- | --- | --- |
| 00-09 | ciclo de vida | 00 dormir · 01 despertar · 02 espera · 03 curiosidad |
| 10-29 | reacciones emocionales | 10 feliz · 13 sorpresa · 14 tímido · 21 enfadado |
| 30-49 | estados de trabajo de IA | 30 pensar · 33 completado · 34 error · 38 rechazar · 40 buscar |
| 50+ | personalizado | registro en tiempo de ejecución |

## Parámetros de creación

| Parámetro | Por defecto | Descripción |
| --- | --- | --- |
| `character` | primer personaje registrado | ID del personaje: `nimbo` / `twinkle` |
| `emotion` | `'02'` | ID de emoción inicial |
| `color` / `eyeColor` | — | Color corporal / de ojos del tema (para instancias de equipo) |
| `eyeScale` | `1` | Escala de los ojos; para tamaños < 80px recomendar 1.5~1.8 |
| `idle` | `false` | Estrategia de espera: conmutación automática tras inactividad / dormir; pasar un objeto para personalizar tiempos y estados |
| `autostart` | `true` | `false` renderiza un solo fotograma estático (para miniaturas) |
| `lite` | sigue `autostart` | Modo ligero: desactiva partículas de efectos y zzz |
| `fallbackId` | `'02'` | Emoción de respaldo para IDs desconocidos |

## Eventos y métodos

```js
mate.on('change', e => {});         // Emoción cambiada { id, def, auto }
mate.on('tips',   e => {});         // Texto opcional de IA { text }
mate.on('error',  e => {});         // Error de protocolo { message, ... }

mate.setEmotion('21');              // Cambio directo
mate.setGaze(nx, ny);               // Mirada normalizada [-1,1]; el anfitrión escucha pointermove
mate.setStyle({ sketch: 1 });       // Modo boceto
mate.celebrate();                  // Celebración de clic: Nimbo sopla burbujas; Twinkle firma + cuerpo + confeti
mate.signature();                  // Solo la acción de firma (burbuja de nube / estallido estelar)
                                    // Devuelve false si el personaje no tiene acción de firma
mate.spin(3);                      // Girar y lanzar partículas (genérico)
mate.burst(24);                    // Confeti
mate.bounce();                     // Rebote
mate.startTour(ids, 2500);         // Recorrido automático / mate.stopTour()
mate.setActive(false);             // Detener fotogramas cuando está fuera de pantalla; true lo reanuda
mate.renderStatic();               // Renderizar un fotograma estático
mate.registerEmotion(raw);         // Registrar emoción personalizada en tiempo de ejecución (rango 50+)
mate.destroy();                    // Destruir instancia
```

## Múltiples instancias y rendimiento

- Todas las instancias comparten un único latido rAF; más instancias no multiplican el costo del bucle;
- Muro de miniaturas: `autostart: false` renderiza estático, al pasar el ratón `setActive(true)`,
  al salir `setActive(false)`;
- Usar IntersectionObserver para `setActive(false)` en instancias fuera de pantalla.

## Mascota de escritorio / Electron

- Parámetros de ventana: `transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true`,
  fondo transparente solo con el contenedor del personaje;
- Transparencia del ratón: `win.setIgnoreMouseEvents(true, { forwardMouseMove: true })`
  — el personaje aún recibe `setGaze`, el clic atraviesa al escritorio;
- Reenvío de mensajes de IA por IPC: `ipcRenderer.on('emotion', (_, msg) => mate.handleAIMessage(msg))`;
- Ventanas pequeñas (≤ 120px) recomendar `eyeScale: 1.5` + `lite: true`.

## Emociones personalizadas

```js
MoodMates.config.register({
  id: '50', name: 'Saludo', group: 'custom',
  pool: ['happy', 'wide'],        // Huecos de forma de ojo (comunes a todos los personajes)
  mouth: 'grin',                  // Hueco de forma de boca
  body: { color: '@soft' },       // Color con @token, se adapta a la paleta de cada personaje
  anims: [ { target: 'body', prop: 'rotate', type: 'sine', amp: 6, period: 900 } ]
});
```

El formato de configuración completo está en los comentarios de cabecera de `src/data/emotions.js`;
importar y exportar con `MoodMates.config.exportConfig()` / `importConfig(json)`.


+++ rostro_animado/docs/INTEGRATION.md (修改后)
# Guía de integración · Integration Guide

Mood Mates es un motor de emociones SVG + JavaScript nativo sin dependencias y sin compilación.
El anfitrión solo necesita cargar los scripts en orden y llamar `MoodMates.create`.

## Integración rápida

```html
<!-- Motor (orden fijo): geometría → renderizado → rasgos → efectos → datos emocionales → motor -->
<script src="src/core/geometry.js"></script>
<script src="src/core/render.js"></script>
<script src="src/core/features.js"></script>
<script src="src/core/fx.js"></script>
<script src="src/data/emotions.js"></script>
<script src="src/core/engine.js"></script>
<!-- Cargar personajes según sea necesario (al menos uno) -->
<script src="src/characters/nimbo.js"></script>

<div id="mate" style="width:200px;height:200px"></div>
<script>
  var mate = MoodMates.create(document.getElementById('mate'), {
    character: 'nimbo',
    emotion: '02',
    idle: true
  });
</script>
```

`site/i18n.js` y `site/app.js` pertenecen al shell de la galería de demostración; el anfitrión no los necesita.

## Protocolo de IA

La IA solo necesita generar un JSON y pasarlo a `handleAIMessage` (acepta objeto o string):

```js
mate.handleAIMessage('{"emotionId":"30","tips":"Pensando en la pregunta del usuario"}');
```

- `emotionId` desconocido, error de análisis JSON, campo faltante: dispara evento `error` y
  vuelve a la emoción de respaldo (`fallbackId`, por defecto `'02'`); nunca deja la pantalla en blanco;
- `tips` es un texto opcional que se entrega mediante el evento `tips` para que el anfitrión lo renderice.

### Regla de segmentación de emotionId (contrato externo, los números nunca se reordenan)

| Rango | Grupo | Comunes |
| --- | --- | --- |
| 00-09 | ciclo de vida | 00 dormir · 01 despertar · 02 espera · 03 curiosidad |
| 10-29 | reacciones emocionales | 10 feliz · 13 sorpresa · 14 tímido · 21 enfadado |
| 30-49 | estados de trabajo de IA | 30 pensar · 33 completado · 34 error · 38 rechazar · 40 buscar |
| 50+ | personalizado | registro en tiempo de ejecución |

## Parámetros de creación

| Parámetro | Por defecto | Descripción |
| --- | --- | --- |
| `character` | primer personaje registrado | ID del personaje: `nimbo` / `twinkle` |
| `emotion` | `'02'` | ID de emoción inicial |
| `color` / `eyeColor` | — | Color corporal / de ojos del tema (para instancias de equipo) |
| `eyeScale` | `1` | Escala de los ojos; para tamaños < 80px recomendar 1.5~1.8 |
| `idle` | `false` | Estrategia de espera: conmutación automática tras inactividad / dormir; pasar un objeto para personalizar tiempos y estados |
| `autostart` | `true` | `false` renderiza un solo fotograma estático (para miniaturas) |
| `lite` | sigue `autostart` | Modo ligero: desactiva partículas de efectos y zzz |
| `fallbackId` | `'02'` | Emoción de respaldo para IDs desconocidos |

## Eventos y métodos

```js
mate.on('change', e => {});         // Emoción cambiada { id, def, auto }
mate.on('tips',   e => {});         // Texto opcional de IA { text }
mate.on('error',  e => {});         // Error de protocolo { message, ... }

mate.setEmotion('21');              // Cambio directo
mate.setGaze(nx, ny);               // Mirada normalizada [-1,1]; el anfitrión escucha pointermove
mate.setStyle({ sketch: 1 });       // Modo boceto
mate.celebrate();                  // Celebración de clic: Nimbo sopla burbujas; Twinkle firma + cuerpo + confeti
mate.signature();                  // Solo la acción de firma (burbuja de nube / estallido estelar)
                                    // Devuelve false si el personaje no tiene acción de firma
mate.spin(3);                      // Girar y lanzar partículas (genérico)
mate.burst(24);                    // Confeti
mate.bounce();                     // Rebote
mate.startTour(ids, 2500);         // Recorrido automático / mate.stopTour()
mate.setActive(false);             // Detener fotogramas cuando está fuera de pantalla; true lo reanuda
mate.renderStatic();               // Renderizar un fotograma estático
mate.registerEmotion(raw);         // Registrar emoción personalizada en tiempo de ejecución (rango 50+)
mate.destroy();                    // Destruir instancia
```

## Múltiples instancias y rendimiento

- Todas las instancias comparten un único latido rAF; más instancias no multiplican el costo del bucle;
- Muro de miniaturas: `autostart: false` renderiza estático, al pasar el ratón `setActive(true)`,
  al salir `setActive(false)`;
- Usar IntersectionObserver para `setActive(false)` en instancias fuera de pantalla.

## Mascota de escritorio / Electron

- Parámetros de ventana: `transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true`,
  fondo transparente solo con el contenedor del personaje;
- Transparencia del ratón: `win.setIgnoreMouseEvents(true, { forwardMouseMove: true })`
  — el personaje aún recibe `setGaze`, el clic atraviesa al escritorio;
- Reenvío de mensajes de IA por IPC: `ipcRenderer.on('emotion', (_, msg) => mate.handleAIMessage(msg))`;
- Ventanas pequeñas (≤ 120px) recomendar `eyeScale: 1.5` + `lite: true`.

## Emociones personalizadas

```js
MoodMates.config.register({
  id: '50', name: 'Saludo', group: 'custom',
  pool: ['happy', 'wide'],        // Huecos de forma de ojo (comunes a todos los personajes)
  mouth: 'grin',                  // Hueco de forma de boca
  body: { color: '@soft' },       // Color con @token, se adapta a la paleta de cada personaje
  anims: [ { target: 'body', prop: 'rotate', type: 'sine', amp: 6, period: 900 } ]
});
```

El formato de configuración completo está en los comentarios de cabecera de `src/data/emotions.js`;
importar y exportar con `MoodMates.config.exportConfig()` / `importConfig(json)`.

---

## Videollamada con bot animado (capa `src/media/` + integración en `index.html`)

### Páginas y responsabilidades

| Página | Rol |
|---|---|
| `call.html` | Demo **standalone** completa: dispositivos + WebRTC + señalización loopback o WebSocket real. |
| `index.html` | Galería principal. Integra la misma capa multimedia como **overlay/modal** (`#callOverlay`) abierto desde el botón ☎ de la topbar. |

### Cómo se integra `call.html` dentro de `index.html`

1. **Mismos módulos, distinto alojamiento.** `index.html` añade al final del
   `<body>` (después de los personajes, antes de `site/i18n.js`):
   ```html
   <script src="src/media/MediaDeviceManager.js"></script>  <!-- MM_Media -->
   <script src="src/media/WebRTCClient.js"></script>        <!-- MM_WebRTC -->
   <script src="src/media/CallSession.js"></script>         <!-- MM_Call -->
   ...
   <script src="site/call.js"></script>                     <!-- glue overlay -->
   ```
2. **El HTML del modal** (`#callMask` + `#callOverlay`) vive en `index.html`,
   replicando los controles de `call.html`: selects de cámara/micrófono/bocina,
   previsualización local (`#callLocalVideo`), audio remoto (`#callRemoteAudio`),
   bot propio (`#callBotBox`) y botones Iniciar/Silenciar/Cámara/Colgar.
3. **`site/call.js` es el pegamento**: copia la lógica del script embebido en
   `call.html` pero sobre el motor ya cargado de la galería. Puntos clave:
   - Setup **perezoso**: `session.setup()` (permisos → `enumerateDevices()`, en
     ese orden para que existan los `label`) corre solo la primera vez que se
     abre el overlay — así la página no pide permisos al cargar.
   - Bot independiente: `MM.create($('callBotBox'), …)` + `session.setMate(mate)`;
     las emociones del bot reaccionan a eventos media/WebRTC sin tocar la galería.
   - Señalización **loopback local** por defecto (dos `RTCPeerConnection` sin
     servidor). Para backend real usar `call.html` (modo WebSocket) o inyectar
     `session.options.signal`.
   - Cerrar el overlay (✕, máscara, `Esc`) cuelga la llamada y libera dispositivos.
   - Enlace profundo: `index.html?call=1` abre el overlay directamente.
4. **i18n y tema**: las claves `callTitle`, `callCamLabel`, `callMicLabel`,
   `callSpkLabel`, `callBtnStart`, `callBtnMute`, `callBtnCam`, `callBtnEnd`,
   `callHint` están en `site/i18n.js` (es/en); el CSS del overlay usa las
   variables `--card/--line/--bg` de `site/style.css`, por lo que respeta el
   tema claro/oscuro de la galería.

### Regla general

`call.html` y `index.html` no se duplican en lógica: ambos consumen la misma
capa `src/media/`. `call.html` = pantalla completa con WebSocket; overlay de
`index.html` = misma API en modo loopback dentro de la galería.

