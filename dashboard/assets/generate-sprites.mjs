#!/usr/bin/env node
/**
 * generate-sprites.mjs — генератор пиксельных спрайтов «Урожайной долины».
 *
 * Персонажи описаны ASCII-сетками (один символ = один ключ палитры).
 * Базовый чиби-шаблон 16x24 (голова ~10px, тело ~8px, ноги ~6px) +
 * ASCII-патчи аксессуаров. Два кадра:
 *   a — контактная поза (ноги врозь, руки в махе, корпус на 1px ниже)
 *   b — проходная поза (ноги вместе, корпус на 1px выше)
 * Переключение a/b читается и как ходьба, и как рабочее покачивание.
 *
 * Дополнительно: char-<id>-portrait.svg — бюст (голова и плечи, верхние
 * 13 строк кадра B без ручного инвентаря) для плашек экипажа.
 *
 * Вывод: чёткие SVG (один <rect> на пиксель, shape-rendering="crispEdges").
 * Запуск:  node generate-sprites.mjs            — записать SVG
 *          node generate-sprites.mjs --print     — показать ASCII-сетки
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const W = 16;
const H = 24;

/* ---------------------------------------------------------------- *
 * Базовый чиби. '.' — прозрачно.
 * Ключи: o контур, h/H волосы, s кожа, e глаза, c румянец, m рот,
 *        b/B рубашка, p/P штаны, k/K обувь.
 * ---------------------------------------------------------------- */

// Кадр B — проходная поза (выше на 1px, ноги вместе).
const BASE_B = [
  '....oooooooo....', // 0  макушка
  '...ohhhhhhhho...', // 1
  '..ohhhhhhhhhho..', // 2
  '..oHhhhhhhhhHo..', // 3
  '..ohhsssssshho..', // 4  чёлка
  '..ohsessssesho..', // 5  глаза
  '..ohcessssecho..', // 6  глаза + румянец
  '..ohsssmmsssho..', // 7  рот
  '...osssssssso...', // 8  подбородок
  '....oossssoo....', // 9  шея
  '...obbbbbbbbo...', // 10 плечи
  '..obbbbbbbbbbo..', // 11
  '..obbbbbbbbbbo..', // 12
  '..oBbbbbbbbbBo..', // 13 рукава
  '..osbBbbbbBbso..', // 14 кисти
  '...oppppppppo...', // 15 пояс
  '...oppppppppo...', // 16
  '....oppppppo....', // 17 бёдра
  '....oppppppo....', // 18 ноги вместе
  '....opPppPpo....', // 19
  '....oppppppo....', // 20
  '....okkkkkko....', // 21 обувь
  '....okKkkKko....', // 22
  '....oooooooo....', // 23 подошва
];

// Кадр A — контактная поза (ниже на 1px, шаг, мах руками).
const BASE_A = [
  '................', // 0  пусто — корпус ниже
  '....oooooooo....', // 1
  '...ohhhhhhhho...', // 2
  '..ohhhhhhhhhho..', // 3
  '..oHhhhhhhhhHo..', // 4
  '..ohhsssssshho..', // 5
  '..ohsessssesho..', // 6
  '..ohcessssecho..', // 7
  '..ohsssmmsssho..', // 8
  '...osssssssso...', // 9
  '....oossssoo....', // 10
  '...obbbbbbbbo...', // 11
  '..obbbbbbbbbbo..', // 12
  '..obbbbbbbbbbo..', // 13
  '..osbbbbbbbbBo..', // 14 левая кисть выше
  '..oBbBbbbbBbso..', // 15 правая кисть ниже
  '...oppppppppo...', // 16
  '...oppppppppo...', // 17
  '...oppppppppo...', // 18 бёдра
  '..oppo....oppo..', // 19 шаг — ноги врозь
  '..oppo....oppo..', // 20
  '..okko....okko..', // 21
  '..okko....okko..', // 22
  '..oooo....oooo..', // 23 подошвы
];

// Кадр SIT — сидя на деревянном стуле (вид спереди).
// Голова на 2px ниже макушки кадра B, торс укорочен, колени вперёд,
// голени вниз. Стул: спинка-стойки по бокам торса (q), сиденье по
// 2px с каждой стороны бёдер, передние ножки по краям, тёмные опоры.
const BASE_SIT = [
  '................', // 0
  '................', // 1
  '....oooooooo....', // 2  макушка
  '...ohhhhhhhho...', // 3
  '..ohhhhhhhhhho..', // 4
  '..oHhhhhhhhhHo..', // 5
  '..ohhsssssshho..', // 6  чёлка
  '..ohsessssesho..', // 7  глаза
  '..ohcessssecho..', // 8  глаза + румянец
  '..ohsssmmsssho..', // 9  рот
  '...osssssssso...', // 10 подбородок
  '.qq.oossssoo.qq.', // 11 шея + верх спинки стула
  '.q.obbbbbbbbo.q.', // 12 плечи + стойки спинки
  '.qobbbbbbbbbboq.', // 13 торс
  '.qoBbbbbbbbbBoq.', // 14 рукава
  '.qosbbbbbbbbsoq.', // 15 кисти на коленях
  '.qoppppppppppoq.', // 16 бёдра (колени вперёд)
  'qqopPppppppPpoqq', // 17 колени + сиденье стула
  'q..oppo..oppo..q', // 18 голени + передние ножки
  'q..oppo..oppo..q', // 19
  'q..okko..okko..q', // 20 обувь
  'q..okKo..okKo..q', // 21
  'q..oooo..oooo..q', // 22 подошвы
  'Q..............Q', // 23 опоры ножек стула
];

// Дерево стула — общая пара ключей, добавляется к палитре персонажа.
const CHAIR_PALETTE = { q: '#9c6b33', Q: '#6b4226' };

/* ---------------------------------------------------------------- *
 * Аксессуары — ASCII-патчи в координатах кадра B.
 * В кадре A патч автоматически опускается на 1px вместе с корпусом.
 * '.' — пропустить пиксель, '!' — стереть в прозрачность.
 * ---------------------------------------------------------------- */

const PATCHES = {
  strawHat: { x: 0, y: 0, rows: [
    '....oooooooo....',
    '...oyyyyyyyyo...',
    '.oyyyyyyyyyyyyo.',
    '..oYYYYYYYYYYo..',
  ]},
  satchel: { x: 0, y: 11, rows: [
    '..........tt....',
    '........tt......',
    '......tt........',
    '....tt..........',
    '..ottto.........',
    '..otTto.........',
    '..ooooo.........',
  ]},
  apron: { x: 0, y: 11, rows: [
    '....aaaaaaaa....',
    '....aaaaaaaa....',
    '....aAaaaaAa....',
    '....aaaaaaaa....',
    '....aaaaaaaa....',
    '....aAaaaaAa....',
    '.....aAAAAa.....',
  ]},
  // shiftAX: в кадре A метла на 1px правее — не съедает ногу в шаге,
  // а лёгкое покачивание читается как подметание.
  broom: { x: 12, y: 8, shiftAX: 1, rows: [
    '.d.',
    '.d.',
    '.d.',
    '.d.',
    '.d.',
    '.d.',
    '.d.',
    '.d.',
    '.d.',
    '.d.',
    'ooo',
    'yyy',
    'yYy',
    'yYy',
    'YYY',
  ]},
  visor: { x: 0, y: 2, rows: [
    '..ovvvvvvvvvvo..',
    '.ovvVVVVVVVVvvo.',
  ]},
  glasses: { x: 0, y: 5, rows: [
    '....g.gggg.g....',
    '....g.g..g.g....',
  ]},
  pencil: { x: 12, y: 4, rows: [
    'xxxX',
  ]},
  redScarf: { x: 0, y: 10, rows: [
    '...orrrrrrrro...',
    '....rrrrrrrr....',
    '.........rr.....',
    '.........rR.....',
  ]},
  clipboard: { x: 0, y: 12, rows: [
    '.oo.............',
    'oooo............',
    'oww.............',
    'oWwo............',
    'owwo............',
    'oooo............',
  ]},
  headband: { x: 0, y: 4, rows: [
    '..orrRrrrrRrro..',
  ]},
  deerstalker: { x: 0, y: 0, rows: [
    '....oooooooo....',
    '...oddddddddo...',
    '..odDdDddDdDdo..',
    '..oDddddddddDo..',
  ]},
  earflaps: { x: 0, y: 4, rows: [
    '..dd........dd..',
    '...D........D...',
  ]},
  magnifier: { x: 12, y: 8, rows: [
    '.zz.',
    'zGGz',
    'zGGz',
    '.zz.',
    '.d..',
    '.d..',
  ]},
  box: { x: 0, y: 12, rows: [
    '...oooooooooo...',
    '...odddxxdddo...',
    '..sodddxxdddos..',
    '...oDddxxddDo...',
    '...oDDdxxdDDo...',
    '...oooooooooo...',
  ]},
  vest: { x: 0, y: 10, rows: [
    '....vv....vv....',
    '...vv......vv...',
    '...vv......vv...',
    '...vv......vv...',
    '....v......v....',
  ]},
  bowtie: { x: 0, y: 10, rows: [
    '......rRRr......',
  ]},
  stamp: { x: 12, y: 15, rows: [
    '.d.',
    'xxx',
    'ooo',
  ]},
  orangeScarf: { x: 0, y: 10, rows: [
    '....rrrrrrrr....',
    'rr..rrrrrrrr....',
    'rR..............',
    'rR..............',
    'oo..............',
  ]},
};

/* ---------------------------------------------------------------- *
 * Размещение патчей в кадре SIT.
 *   false      — аксессуар отложен на стол (инструменты в руках не нужны),
 *   { y }      — патч на новой высоте (голова в SIT на 2px ниже кадра B),
 *   { y, rows }— замена строк (фартук укорочен под сидячую позу).
 * ---------------------------------------------------------------- */

const SIT_PATCHES = {
  strawHat: { y: 2 },
  satchel: false, // сумка висит у стола
  apron: { y: 13, rows: [
    '....aaaaaaaa....',
    '....aAaaaaAa....',
    '....aaaaaaaa....',
    '....aaaaaaaa....',
    '....aAaaaaAa....',
    '.....aAAAAa.....',
  ]},
  broom: false, // метла прислонена к стене
  visor: { y: 4 },
  glasses: { y: 7 },
  pencil: { y: 6 },
  redScarf: { y: 12 },
  clipboard: false, // планшет лежит на столе
  headband: { y: 6 },
  deerstalker: { y: 2 },
  earflaps: { y: 6 },
  magnifier: false, // лупа на столе
  box: false, // коробка стоит рядом со столом
  vest: { y: 12 },
  bowtie: { y: 12 },
  stamp: false, // печать на столе
  orangeScarf: { y: 12 },
};

/* ---------------------------------------------------------------- *
 * Бюст-портрет: верхние строки кадра B (макушка..грудь), лицо крупно.
 * Ручной инвентарь в кадр не попадает — у бюста нет рук.
 * ---------------------------------------------------------------- */

const PORTRAIT_ROWS = 13; // строки 0-12 кадра B: голова, шея, плечи
const PORTRAIT_EXCLUDE = new Set(['broom', 'magnifier', 'clipboard', 'box', 'stamp']);

function composePortrait(def) {
  const names = def.patches.filter((name) => !PORTRAIT_EXCLUDE.has(name));
  return composeFrame(BASE_B, names, false).slice(0, PORTRAIT_ROWS);
}

/* ---------------------------------------------------------------- *
 * Персонажи: палитра + список патчей. Разные тона кожи и волос.
 * ---------------------------------------------------------------- */

const OUTLINE = '#54331a';
const EYES = '#2b2421';

const CHARACTERS = {
  'char-scraper': { // соломенная шляпа + сумка через плечо
    patches: ['strawHat', 'satchel'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#8a5a2b', H: '#6b4226', s: '#e8b078', c: '#e0926a', m: '#9c5a48',
      b: '#76a83e', B: '#5d8a30', p: '#6b4a2a', P: '#523620',
      k: '#3a2417', K: '#5a3a24',
      y: '#e0bd55', Y: '#bd9638', t: '#8a5a2b', T: '#6b4226',
    },
  },
  'char-cleaner': { // фартук + метла
    patches: ['apron', 'broom'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#2e2018', H: '#1a120c', s: '#f2cfa5', c: '#eda687', m: '#9c5a48',
      b: '#c96f4a', B: '#a8542f', p: '#5a4632', P: '#463524',
      k: '#3a2417', K: '#5a3a24',
      a: '#f3ead2', A: '#d9ccab', d: '#8a5a2b', y: '#d8b04a', Y: '#b08a2e',
    },
  },
  'char-editor': { // зелёный козырёк + очки + карандаш
    patches: ['visor', 'glasses', 'pencil'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#4a2f1a', H: '#38220f', s: '#c98a5a', c: '#b06a40', m: '#7a4530',
      b: '#5b87a8', B: '#46698a', p: '#4a3b2d', P: '#382c20',
      k: '#3a2417', K: '#5a3a24',
      v: '#3a6e1f', V: '#2c5417', g: '#2b2421', x: '#e3a93a', X: '#3a2417',
    },
  },
  'char-validator': { // красный шарф + планшет
    patches: ['redScarf', 'clipboard'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#241a12', H: '#140d08', s: '#8d5524', c: '#a86038', m: '#5f351c',
      b: '#e8d9b0', B: '#cfc090', p: '#4f6d8c', P: '#3d5773',
      k: '#3a2417', K: '#5a3a24',
      r: '#a8431f', R: '#8a3417', w: '#f6f0dc', W: '#b3a99a',
    },
  },
  'char-runner': { // повязка на лоб + белые кроссовки с полосой
    patches: ['headband'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#b5562a', H: '#8f3f1d', s: '#e8b078', c: '#e0926a', m: '#9c5a48',
      b: '#f3ead2', B: '#d9ccab', p: '#4f7d9c', P: '#3c627e',
      k: '#f3ead2', K: '#c96f4a',
      r: '#f6f0dc', R: '#d9ccab', // белая спортивная повязка — контраст с рыжими волосами
    },
  },
  'char-sniffer': { // кепка охотника + лупа
    patches: ['deerstalker', 'earflaps', 'magnifier'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#8c8478', H: '#6e675c', s: '#f2cfa5', c: '#eda687', m: '#9c5a48',
      b: '#b08a52', B: '#93703f', p: '#5a4632', P: '#463524',
      k: '#3a2417', K: '#5a3a24',
      d: '#8a5a2b', D: '#6b4226', z: '#b9852e', G: '#cfe6e6',
    },
  },
  'char-archiver': { // несёт коробку
    patches: ['box'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#d8b04a', H: '#b08a2e', s: '#c98a5a', c: '#b06a40', m: '#7a4530',
      b: '#4f6d8c', B: '#3d5773', p: '#3d5773', P: '#2e4356',
      k: '#3a2417', K: '#5a3a24',
      d: '#c98e4f', D: '#a86f35', x: '#e3c25a',
    },
  },
  'char-signoff': { // бабочка + жилет + печать
    patches: ['vest', 'bowtie', 'stamp'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#d9d2c4', H: '#b3a99a', s: '#f2cfa5', c: '#eda687', m: '#9c5a48',
      b: '#f3ead2', B: '#d9ccab', p: '#4a3b2d', P: '#382c20',
      k: '#3a2417', K: '#5a3a24',
      v: '#3a6e1f', r: '#a8431f', R: '#7e2f12', d: '#8a5a2b', x: '#a8431f',
    },
  },
  'char-boss': { // ОРАНЖЕВЫЙ шарф — Главный Агент
    patches: ['orangeScarf'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#3a2417', H: '#271509', s: '#e8b078', c: '#e0926a', m: '#9c5a48',
      b: '#e8d9b0', B: '#cfc090', p: '#6b4a2a', P: '#523620',
      k: '#3a2417', K: '#5a3a24',
      r: '#d97b29', R: '#b35e17',
    },
  },
};

/* ---------------------------------------------------------------- *
 * Посылка 12x10 — крафт-бумага, перевязана золотой бечёвкой.
 * ---------------------------------------------------------------- */

const PARCEL = {
  width: 12,
  height: 10,
  palette: { o: OUTLINE, d: '#c98e4f', D: '#a86f35', t: '#e3a93a', K: '#b9852e' },
  grid: [
    '.oooottoooo.',
    'oddddttddddo',
    'odddDttDdddo',
    'otttttttttto',
    'ottttKKtttto',
    'odddDttDdddo',
    'oddddttddddo',
    'oDDdDttDdDDo',
    'oDDDDttDDDDo',
    '.oooooooooo.',
  ],
};

/* ---------------------------------------------------------------- *
 * Лист бумаги 10x8 — белый, контур 1px, три серые строки текста.
 * ---------------------------------------------------------------- */

const PAPER = {
  width: 10,
  height: 8,
  palette: { o: OUTLINE, w: '#f6f0dc', g: '#b3a99a' },
  grid: [
    'oooooooooo',
    'owwwwwwwwo',
    'owggggggwo',
    'owwwwwwwwo',
    'owgggggwwo',
    'owwwwwwwwo',
    'owggggwwwo',
    'oooooooooo',
  ],
};

/* ---------------------------------------------------------------- *
 * Сборка и вывод.
 * ---------------------------------------------------------------- */

function applyPatch(grid, patch, yShift, xShift) {
  const out = grid.map((row) => row.split(''));
  patch.rows.forEach((prow, dy) => {
    const y = patch.y + dy + yShift;
    if (y < 0 || y >= grid.length) {
      throw new Error(`Patch row out of bounds: y=${y}`);
    }
    for (let dx = 0; dx < prow.length; dx++) {
      const ch = prow[dx];
      if (ch === '.') continue;
      const x = patch.x + dx + xShift;
      if (x < 0 || x >= out[y].length) {
        throw new Error(`Patch col out of bounds: x=${x}, y=${y}`);
      }
      out[y][x] = ch === '!' ? '.' : ch;
    }
  });
  return out.map((row) => row.join(''));
}

function composeFrame(base, patchNames, isFrameA) {
  let grid = base;
  for (const name of patchNames) {
    const patch = PATCHES[name];
    if (!patch) throw new Error(`Unknown patch: ${name}`);
    const yShift = isFrameA ? 1 : 0;
    const xShift = isFrameA ? (patch.shiftAX || 0) : 0;
    grid = applyPatch(grid, patch, yShift, xShift);
  }
  return grid;
}

// Сидячий кадр: те же патчи, но по таблице SIT_PATCHES
// (инструменты отложены, остальное пересажено по высоте).
function composeSitFrame(patchNames) {
  let grid = BASE_SIT;
  for (const name of patchNames) {
    const sit = SIT_PATCHES[name];
    if (sit === false) continue;
    if (!sit) throw new Error(`No SIT placement for patch: ${name}`);
    const src = PATCHES[name];
    if (!src) throw new Error(`Unknown patch: ${name}`);
    const patch = { x: src.x, y: sit.y, rows: sit.rows || src.rows };
    grid = applyPatch(grid, patch, 0, 0);
  }
  return grid;
}

function validateGrid(name, grid, width, height, palette) {
  if (grid.length !== height) {
    throw new Error(`${name}: expected ${height} rows, got ${grid.length}`);
  }
  grid.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error(`${name}: row ${y} has length ${row.length}, expected ${width} -> "${row}"`);
    }
    for (const ch of row) {
      if (ch !== '.' && !palette[ch]) {
        throw new Error(`${name}: row ${y} has unknown palette key "${ch}"`);
      }
    }
  });
}

function gridToSvg(grid, palette, width, height) {
  const rects = [];
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[ch]}"/>`);
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">`,
    ...rects,
    '</svg>',
    '',
  ].join('\n');
}

function printGrid(name, grid) {
  console.log(`\n--- ${name} ---`);
  for (const row of grid) console.log(row.replace(/\./g, ' '));
}

const printMode = process.argv.includes('--print');
const written = [];

for (const [id, def] of Object.entries(CHARACTERS)) {
  const frames = {
    a: composeFrame(BASE_A, def.patches, true), // контактная поза: патчи на 1px ниже
    b: composeFrame(BASE_B, def.patches, false), // проходная поза
    sit: composeSitFrame(def.patches), // сидя за рабочим столом
  };
  for (const [suffix, grid] of Object.entries(frames)) {
    const name = `${id}-${suffix}`;
    const palette = suffix === 'sit' ? { ...def.palette, ...CHAIR_PALETTE } : def.palette;
    validateGrid(name, grid, W, H, palette);
    if (printMode) printGrid(name, grid);
    const file = join(OUT, `${name}.svg`);
    writeFileSync(file, gridToSvg(grid, palette, W, H));
    written.push(`${name}.svg`);
  }
  // Бюст-портрет для плашек экипажа (голова и плечи, лицо крупно).
  const portrait = composePortrait(def);
  const portraitName = `${id}-portrait`;
  validateGrid(portraitName, portrait, W, PORTRAIT_ROWS, def.palette);
  if (printMode) printGrid(portraitName, portrait);
  writeFileSync(join(OUT, `${portraitName}.svg`), gridToSvg(portrait, def.palette, W, PORTRAIT_ROWS));
  written.push(`${portraitName}.svg`);
}

validateGrid('item-parcel', PARCEL.grid, PARCEL.width, PARCEL.height, PARCEL.palette);
if (printMode) printGrid('item-parcel', PARCEL.grid);
writeFileSync(join(OUT, 'item-parcel.svg'), gridToSvg(PARCEL.grid, PARCEL.palette, PARCEL.width, PARCEL.height));
written.push('item-parcel.svg');

validateGrid('item-paper', PAPER.grid, PAPER.width, PAPER.height, PAPER.palette);
if (printMode) printGrid('item-paper', PAPER.grid);
writeFileSync(join(OUT, 'item-paper.svg'), gridToSvg(PAPER.grid, PAPER.palette, PAPER.width, PAPER.height));
written.push('item-paper.svg');

console.log(`OK: ${written.length} SVG written to ${OUT}`);
for (const f of written) console.log('  ' + f);
