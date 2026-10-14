#!/usr/bin/env node
/* ============================================================
 * seed-to-json.js — Generador + validador del catálogo de emociones
 *
 *   node tools/seed-to-json.js            → genera data/emotions.json
 *                                            y regenera el enum `mouth` de
 *                                            data/emotions.schema.json
 *   node tools/seed-to-json.js --check    → valida sin escribir (exit 1 si hay errores):
 *                                            seed válido + data/emotions.json y
 *                                            emotions.schema.json al día
 *
 * Fuentes vivas (A5): las listas de huecos (mouthSlots) y de presets se LEEN
 * de src/core/geometry.js y src/core/engine.js respectivamente — ya no existen
 * copias manuales que se desfasen. El schema también se deriva de geometry.js.
 *
 * Lee src/data/emotions.js (datos puros: window.EMOTION_SEED / EMOTION_GROUPS),
 * lo evalúa en un sandbox mínimo y emite el catálogo externo que consume
 * MM.config.loadFromUrl() en el sitio. El formato es { $schema, version,
 * presets, emotions } según data/emotions.schema.json.
 *
 * Sin dependencias externas.
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var SEED_FILE = path.join(ROOT, 'src', 'data', 'emotions.js');
var EMOJI_MAP_FILE = path.join(ROOT, 'src', 'data', 'emoji-map.js');
var GEOMETRY_FILE = path.join(ROOT, 'src', 'core', 'geometry.js');
var ENGINE_FILE = path.join(ROOT, 'src', 'core', 'engine.js');
var OUT_FILE = path.join(ROOT, 'data', 'emotions.json');
var SCHEMA_FILE = path.join(ROOT, 'data', 'emotions.schema.json');
var CHECK_ONLY = process.argv.indexOf('--check') >= 0;

/* ---------------- Leer los huecos de boca desde la fuente viva ----------------
 * geometry.js es un IIFE que cuelga de `window`; se evalúa en un sandbox mínimo.
 * Si cambiara a CommonJS, añadir `module.exports` allí y usar require() aquí. */

var geoSb = { window: {} };
vm.createContext(geoSb);
vm.runInContext(fs.readFileSync(GEOMETRY_FILE, 'utf8'), geoSb, { filename: 'geometry.js' });
var GEO = geoSb.window.MoodMates && geoSb.window.MoodMates.geo;
if (!GEO || !Array.isArray(GEO.mouthSlots)) {
  console.error('✗ src/core/geometry.js no expone MoodMates.geo.mouthSlots (revisa el sandbox de este script)');
  process.exit(1);
}
var MOUTHS = GEO.mouthSlots;

/* ---------------- Leer los presets desde la fuente viva ----------------
 * engine.js no puede evaluarse en Node (usa document/performance/rAF), así que
 * se extrae la tabla `var PRESETS = {…};` y se evalúa como objeto literal.
 * El cierre es la primera línea `};` tras la apertura (columna 0 o 2, único
 * nivel de cierre posible dentro de la tabla: sus valores no anidan objetos a
 * esa indentación). */

var engineSrc = fs.readFileSync(ENGINE_FILE, 'utf8');
var pStart = engineSrc.indexOf('var PRESETS = {');
if (pStart < 0) {
  console.error('✗ No se encontró la tabla `var PRESETS = {…};` en src/core/engine.js (¿cambió el formato?)');
  process.exit(1);
}
var tail = engineSrc.slice(pStart);
var mEnd = tail.match(/\n(?:  )?\};/);
if (!mEnd) {
  console.error('✗ No se encontró el cierre de la tabla PRESETS en src/core/engine.js');
  process.exit(1);
}
var preSrc = tail.slice(tail.indexOf('{'), mEnd.index + mEnd[0].length - 1); // hasta el ';'
var PRESETS;
try {
  PRESETS = vm.runInNewContext('(' + preSrc + ')', {});
} catch (e) {
  console.error('✗ La tabla PRESETS de engine.js no es un literal evaluable: ' + e.message);
  process.exit(1);
}

/* ---------------- Cargar el seed (datos puros sobre window) ---------------- */

var sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SEED_FILE, 'utf8'), sandbox, { filename: 'emotions.js' });
/* Extensión emoji U+1F600–U+1F637: misma fuente que usa engine.js al arrancar. */
if (fs.existsSync(EMOJI_MAP_FILE)) {
  vm.runInContext(fs.readFileSync(EMOJI_MAP_FILE, 'utf8'), sandbox, { filename: 'emoji-map.js' });
}

var seed = sandbox.window.EMOTION_SEED;
if (!Array.isArray(seed)) {
  console.error('✗ src/data/emotions.js no define window.EMOTION_SEED como array');
  process.exit(1);
}
var EMOJI_SEED = sandbox.window.EMOTION_EMOJI_SEED;
if (EMOJI_SEED != null && !Array.isArray(EMOJI_SEED)) {
  console.error('✗ src/data/emoji-map.js define window.EMOTION_EMOJI_SEED pero no es un array');
  process.exit(1);
}
/* El catálogo materializado = seed base + extensión emoji (si existe). */
var catalog = seed.concat(EMOJI_SEED || []);

/* ---------------- Validación ligera (la fuerte la hace el motor al importar) ---------------- */

var errors = [];
var seen = {};
var ID_RE = /^(0[0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|[5-9][0-9])$/;
var EMOJI_ID_RE = /^e1f6(0[0-9a-f]|[1-2][0-9a-f]|3[0-7])$/;   /* U+1F600–U+1F637 */
var GROUPS = ['life', 'emotion', 'agent', 'custom'];
/* MOUTHS viene de geometry.js (línea viva, A5) — no duplicar aquí. */
var ANIM_TYPES = ['sine', 'pulse', 'jitter', 'scan', 'glance', 'blink'];
/* Perfiles de parpadeo: leídos de engine.js (BLINK_PROFILES) — misma política A5. */
var bpMatch = engineSrc.match(/var BLINK_PROFILES = \{([\s\S]*?)\n  \};/);
var BLINK_NAMES = [];
if (bpMatch) {
  var bodyLines = bpMatch[1].split('\n');
  for (var bi = 0; bi < bodyLines.length; bi++) {
    var bm = bodyLines[bi].match(/^\s*([A-Za-z_]\w*)\s*:/);
    if (bm) BLINK_NAMES.push(bm[1]);
  }
} else {
  console.error('✗ No se encontró la tabla `var BLINK_PROFILES = {…};` en src/core/engine.js');
  process.exit(1);
}

catalog.forEach(function (raw, i) {
  var tag = '[' + (raw && raw.id ? raw.id : '#' + i) + ']';
  if (!raw || typeof raw !== 'object') { errors.push(tag + ' entrada no-objeto'); return; }
  if (typeof raw.id !== 'string' || !(ID_RE.test(raw.id) || EMOJI_ID_RE.test(raw.id))) {
    errors.push(tag + ' id fuera del patrón NN o e1f6xx');
  }
  if (seen[raw.id]) errors.push(tag + ' id duplicado');
  seen[raw.id] = true;
  if (GROUPS.indexOf(raw.group) < 0) errors.push(tag + ' group inválido: ' + raw.group);
  if (raw.mouth != null && MOUTHS.indexOf(raw.mouth) < 0) errors.push(tag + ' mouth desconocido: ' + raw.mouth);
  if (raw.cp != null && (typeof raw.cp !== 'number' || !isFinite(raw.cp) || raw.cp < 0)) {
    errors.push(tag + ' cp debe ser un codepoint numérico: ' + raw.cp);
  }
  if (raw.blinkProfile != null && BLINK_NAMES.indexOf(raw.blinkProfile) < 0) {
    errors.push(tag + ' blinkProfile desconocido: ' + raw.blinkProfile);
  }
  if (raw.anims != null) {
    if (!Array.isArray(raw.anims)) errors.push(tag + ' anims no es array');
    else raw.anims.forEach(function (a, j) {
      if (!a || ANIM_TYPES.indexOf(a.type) < 0) errors.push(tag + ' anims[' + j + '] tipo desconocido');
    });
  }
  if (raw.sequence != null) {
    if (!Array.isArray(raw.sequence.frames)) errors.push(tag + ' sequence.frames no es array');
    else raw.sequence.frames.forEach(function (f, j) {
      if (!f || typeof f.at !== 'number' || f.at < 0) errors.push(tag + ' sequence.frames[' + j + '].at inválido');
    });
  }
});

if (errors.length) {
  console.error('✗ Errores de validación en el seed:\n  ' + errors.join('\n  '));
  process.exit(1);
}

/* ---------------- Enum `mouth` del schema, derivado de geometry.js (A5) ----------------
 * Se inyecta entre marcadores para no reescribir el resto del schema a ciegas. */

var MOUTH_ENUM_LINE = '        "mouth": { "enum": [' + MOUTHS.map(function (s) { return '"' + s + '"'; }).join(', ') + '] },';
var MARK_BEGIN = '  /* AUTO:MOUTH-ENUM-BEGIN — generado por tools/seed-to-json.js a partir de src/core/geometry.js: NO EDITAR A MANO */';
var MARK_END   = '        /* AUTO:MOUTH-ENUM-END */';

function mouthEnumBlock() { return MARK_BEGIN + '\n' + MOUTH_ENUM_LINE + '\n' + MARK_END; }

function syncSchema(checkOnly) {
  if (!fs.existsSync(SCHEMA_FILE)) {
    console.error('✗ Falta data/emotions.schema.json');
    process.exit(1);
  }
  var src = fs.readFileSync(SCHEMA_FILE, 'utf8');
  var eol = src.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  function toEol(s) { return eol === '\n' ? s : s.replace(/\n/g, eol); }
  var nb = toEol(MARK_BEGIN), ne = toEol(MARK_END);
  var i = src.indexOf(nb), j = src.indexOf(ne);
  var outSrc;
  if (i >= 0 && j > i) {
    outSrc = src.slice(0, i) + mouthEnumBlock().replace(/\n/g, eol === '\n' ? '\n' : '\r\n') + src.slice(j + ne.length);
  } else {
    /* sin marcadores: primera pasada — envolver la línea actual del enum de mouth */
    var mLine = src.match(/([ \t]*"mouth": \{ "enum": \[[^\]]*\] \},)/);
    if (!mLine) {
      console.error('✗ No se encontró la propiedad "mouth" en emotions.schema.json para insertar los marcadores AUTO');
      process.exit(1);
    }
    var indent = mLine[1].slice(0, mLine[1].length - mLine[1].trimStart().length);
    var block = indent + MARK_BEGIN.replace(/^ */, '') + eol + MOUTH_ENUM_LINE + eol + indent + MARK_END.replace(/^ */, '') + eol;
    outSrc = src.replace(mLine[1], block.replace(/\n$/, ''));
  }
  if (checkOnly) {
    var curM = src.match(/"mouth": \{ "enum": \[([^\]]*)\] \}/);
    var want = MOUTHS.map(function (s) { return '"' + s + '"'; }).join(', ');
    if (!curM || curM[1].trim() !== want) {
      console.error('✗ data/emotions.schema.json está desfasado respecto a mouthSlots de geometry.js.\n  esperado: ' + want + '\n  actual:  ' + (curM ? curM[1].trim() : '(sin enum de mouth)') + '\n  Ejecuta: node tools/seed-to-json.js');
      process.exit(1);
    }
    return;
  }
  fs.writeFileSync(SCHEMA_FILE, outSrc);
}

/* ---------------- Emitir / comprobar ---------------- */

var out = {
  $schema: './emotions.schema.json',
  version: new Date().toISOString().slice(0, 10),
  generatedBy: 'tools/seed-to-json.js',
  presets: PRESETS,
  emotions: catalog
};

var json = JSON.stringify(out, null, 2) + '\n';

if (CHECK_ONLY) {
  /* A4/A5: el catálogo publicado debe estar al día respecto al seed y al schema. */
  if (fs.existsSync(OUT_FILE)) {
    var current = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    if (JSON.stringify(current.emotions) !== JSON.stringify(catalog)) {
      console.error('✗ data/emotions.json está desfasado respecto a src/data/emotions.js. Ejecuta: node tools/seed-to-json.js');
      process.exit(1);
    }
    if (JSON.stringify(current.presets || {}) !== JSON.stringify(PRESETS)) {
      console.error('✗ Los presets de data/emotions.json no coinciden con PRESETS de engine.js. Ejecuta: node tools/seed-to-json.js');
      process.exit(1);
    }
  } else {
    console.error('✗ Falta data/emotions.json. Ejecuta: node tools/seed-to-json.js');
    process.exit(1);
  }
  syncSchema(true);
  console.log('✓ catálogo válido: ' + catalog.length + ' emociones (' + seed.length + ' base + ' +
              (EMOJI_SEED ? EMOJI_SEED.length : 0) + ' emoji), ids únicos, grupos y slots correctos · ' +
              'data/emotions.json y emotions.schema.json al día (' + MOUTHS.length + ' huecos de boca) (--check, no se escribió nada)');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, json);
syncSchema(false);
console.log('✓ data/emotions.json generado: ' + catalog.length + ' emociones (' + seed.length + ' base + ' + (EMOJI_SEED ? EMOJI_SEED.length : 0) + ' emoji; ' + (json.length / 1024).toFixed(1) + ' KB) · enum mouth del schema sincronizado (' + MOUTHS.length + ' huecos)');
