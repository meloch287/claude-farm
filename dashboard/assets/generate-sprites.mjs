#!/usr/bin/env node
/**
 * generate-sprites.mjs — генератор пиксельных спрайтов «Клауд Фермы».
 *
 * Персонажи — фермеры: соломенные шляпы, комбинезоны, банданы,
 * вилы и лейки. Описаны ASCII-сетками (один символ = один ключ палитры).
 * Базовый чиби-шаблон 16x24 (голова ~10px, тело ~8px, ноги ~6px) +
 * ASCII-патчи аксессуаров. Два кадра:
 *   a — контактная поза (ноги врозь, руки в махе, корпус на 1px ниже)
 *   b — проходная поза (ноги вместе, корпус на 1px выше)
 * Переключение a/b читается и как ходьба, и как рабочее покачивание.
 *
 * Дополнительно: char-<id>-portrait.svg — бюст (голова и плечи, верхние
 * 13 строк кадра B без ручного инвентаря) для плашек экипажа, и
 * char-helper1..4 (только кадры a/b) — молодые подручные-субагенты.
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

// Кадр SIT — сидя на деревянном табурете (вид спереди).
// Голова на 2px ниже макушки кадра B, торс укорочен, колени вперёд,
// голени вниз. Табурет: спинка-стойки по бокам торса (q), сиденье по
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
  '.qq.oossssoo.qq.', // 11 шея + верх спинки
  '.q.obbbbbbbbo.q.', // 12 плечи + стойки спинки
  '.qobbbbbbbbbboq.', // 13 торс
  '.qoBbbbbbbbbBoq.', // 14 рукава
  '.qosbbbbbbbbsoq.', // 15 кисти на коленях
  '.qoppppppppppoq.', // 16 бёдра (колени вперёд)
  'qqopPppppppPpoqq', // 17 колени + сиденье
  'q..oppo..oppo..q', // 18 голени + передние ножки
  'q..oppo..oppo..q', // 19
  'q..okko..okko..q', // 20 обувь
  'q..okKo..okKo..q', // 21
  'q..oooo..oooo..q', // 22 подошвы
  'Q..............Q', // 23 опоры ножек
];

// Дерево табурета — общая пара ключей, добавляется к палитре персонажа.
const CHAIR_PALETTE = { q: '#9c6b33', Q: '#6b4226' };

/* ---------------------------------------------------------------- *
 * Рабочая палитра — общие ключи для chore-кадров (work1/work2).
 * Добавляется к палитре КАЖДОГО рабочего, чтобы инструменты и
 * частицы рисовались одинаково независимо от персонажа.
 *   j/J — дерево черенка/ручки (светлое/тёмное)
 *   f/F — металл лезвия/тины (светлое/тёмное)
 *   u/U — мешок зерна (холст/тень)
 *   l/L — лейка-металл (корпус/тень), i — струя/капля воды
 *   a/A — урожай (яблоко/тень), G — золотая монета
 *   s   — кожа (уже есть у всех), o — контур (уже есть)
 * ---------------------------------------------------------------- */
const WORK_PALETTE = {
  j: '#a9763d', J: '#7a5226',           // черенок (дерево)
  f: '#c8c2b4', F: '#8f897c',           // металл лезвия
  u: '#e8d9b0', U: '#c2ab74',           // мешок (холст)
  l: '#b8c4cc', L: '#7d8a92',           // лейка (оцинковка)
  i: '#6fb7e0',                          // вода (струя/капля)
  a: '#c44b34', A: '#8f2f1c',           // урожай (яблоко)
  G: '#e3b23a',                          // монета (золото)
};

/* ---------------------------------------------------------------- *
 * Аксессуары — ASCII-патчи в координатах кадра B.
 * В кадре A патч автоматически опускается на 1px вместе с корпусом.
 * '.' — пропустить пиксель, '!' — стереть в прозрачность.
 * ---------------------------------------------------------------- */

const PATCHES = {
  // соломенная шляпа с широкими полями
  strawHat: { x: 0, y: 0, rows: [
    '....oooooooo....',
    '...oyyyyyyyyo...',
    '.oyyyyyyyyyyyyo.',
    '..oYYYYYYYYYYo..',
  ]},
  // бандана-косынка на голове
  headwrap: { x: 0, y: 0, rows: [
    '....oooooooo....',
    '...orrrrrrrro...',
    '..orrrrrrrrrro..',
    '..oRrrrrrrrrRo..',
  ]},
  // нагрудник комбинезона с лямками (низ — штаны в тон n/N)
  overalls: { x: 0, y: 10, rows: [
    '....n......n....',
    '....n......n....',
    '....n......n....',
    '.....nnnnnn.....',
    '.....nNnnNn.....',
  ]},
  // шейный платок-косынка с узелком
  kerchief: { x: 0, y: 10, rows: [
    '...orrrrrrrro...',
    '....rrrRrrrr....',
  ]},
  // сумка для урожая через плечо
  satchel: { x: 0, y: 11, rows: [
    '..........tt....',
    '........tt......',
    '......tt........',
    '....tt..........',
    '..ottto.........',
    '..otTto.........',
    '..ooooo.........',
  ]},
  // вилы: три зубца вверх (на уровне плеча), черенок до земли
  // shiftAX: в кадре A на 1px правее — лёгкое покачивание при шаге
  pitchfork: { x: 12, y: 9, shiftAX: 1, rows: [
    'f.f',
    'f.f',
    'fff',
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
    '.D.',
  ]},
  // садовая лейка в правой руке
  wateringCan: { x: 11, y: 14, rows: [
    '.oo..',
    'o..o.',
    'wwww.',
    'wwwwW',
    'wWWw.',
  ]},
  glasses: { x: 0, y: 5, rows: [
    '....g.gggg.g....',
    '....g.g..g.g....',
  ]},
  pencil: { x: 12, y: 4, rows: [
    'xxxX',
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
  magnifier: { x: 12, y: 8, rows: [
    '.zz.',
    'zGGz',
    'zGGz',
    '.zz.',
    '.d..',
    '.d..',
  ]},
  // ящик с урожаем в руках
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
 *   false      — аксессуар отложен (инструменты в руках не нужны),
 *   { y }      — патч на новой высоте (голова в SIT на 2px ниже кадра B),
 *   { y, rows }— замена строк (нагрудник укорочен под сидячую позу).
 * ---------------------------------------------------------------- */

const SIT_PATCHES = {
  strawHat: { y: 2 },
  headwrap: { y: 2 },
  overalls: { y: 12, rows: [
    '....n......n....',
    '.....nnnnnn.....',
    '.....nNnnNn.....',
  ]},
  kerchief: { y: 12 },
  satchel: false, // сумка висит у грядки
  pitchfork: false, // вилы воткнуты в землю рядом
  wateringCan: false, // лейка стоит у ног
  glasses: { y: 7 },
  pencil: { y: 6 },
  clipboard: false, // планшет лежит на верстаке
  headband: { y: 6 },
  magnifier: false, // лупа на столе
  box: false, // ящик стоит рядом
  vest: { y: 12 },
  stamp: false, // печать на прилавке
  orangeScarf: { y: 12 },
};

/* ================================================================ *
 * РАБОЧИЕ КАДРЫ (chore) — work1 / work2 для 8 рабочих.
 *
 * Каждый кадр — патч поверх BASE_B (стоячая поза, ноги вместе):
 * перерисовывает руку (правый рукав/кисть) и рисует инструмент так,
 * чтобы пара кадров читалась как ОДНО рабочее движение с дугой.
 * '!' стирает пиксель в прозрачность, '.' — пропуск.
 *
 * Зоны → движение:
 *   field  (Поле/scraper,cleaner): КОПАТЬ — мотыга вверх / удар в землю
 *   barn   (Амбар/editor,validator): МЕШКИ — у пояса / на плече
 *   green  (Теплица/runner,sniffer): ПОЛИВ — лейка ровно / наклон, капли
 *   market (Рынок/archiver,signoff): ТОРГ — товар у груди / рука вперёд, монета
 *
 * Патч начинается с y=10 (плечи) — голову и ноги BASE_B не трогаем.
 * ================================================================ */

// Полные 16x24 сетки рабочих поз. Тело использует общие ключи
// (o,h,H,s,c,m,b,B,p,P,k,K) — рендерится в цветах любого персонажа;
// головной убор персонажа накладывается сверху отдельным патчем.
// Голова/лицо/ноги совпадают с BASE_B, меняются только руки + инструмент.

const CHORE_FRAMES = {
  // ===== ПОЛЕ — КОПАТЬ (мотыга, двуручный замах вверх→в землю) =====
  // Силуэт-читаемость: лезвие мотыги (fF) ВЫНЕСЕНО за контур тела —
  // в work1 высоко над/сбоку головы, в work2 ушло к земле справа.
  // Длинный диагональный черенок (jJ) пересекает кадр по диагонали:
  // пара кадров читается как замах сверху-вниз даже в 16px.
  // work1: мотыга ЗАНЕСЕНА — лезвие в правом верхнем углу НАД головой,
  //        черенок диагональю вниз-влево к двум рукам у пояса.
  field1: [
    '....oooooooo.fFF', //  0 лезвие мотыги в правом верхнем углу
    '...ohhhhhhhhofFF', //  1 лезвие над плечом
    '..ohhhhhhhhhhjJ.', //  2 черенок пошёл от лезвия вниз-влево
    '..oHhhhhhhhhjJo.', //  3
    '..ohhsssssssjJ..', //  4 черенок по диагонали мимо лица
    '..ohsessssesjJo.', //  5
    '..ohcesssscjJho.', //  6
    '..ohsssmmsjJsho.', //  7
    '...ossssssjJoo..', //  8
    '....oosssjJoo...', //  9 черенок к плечу
    '...obbbbjJbbo...', // 10
    '..obbbbsjJbbbo..', // 11 верхняя рука на черенке
    '..obbbbbjJbbbo..', // 12
    '..oBbbbbsjsbBo..', // 13 нижняя рука на черенке
    '..osbBbbbbBbso..', // 14
    '...oppppppppo...', // 15
    '...oppppppppo...', // 16
    '....oppppppo....', // 17
    '....oppppppo....', // 18
    '....opPppPpo....', // 19
    '....oppppppo....', // 20
    '....okkkkkko....', // 21
    '....okKkkKko....', // 22
    '....oooooooo....', // 23
  ],
  // work2: УДАР — мотыга прошла вниз, лезвие ВРЕЗАЛОСЬ в землю справа
  //        от ног (за контуром тела), черенок диагональю снизу-справа
  //        к рукам; корпус чуть наклонён, кисти вытянуты вперёд-вниз.
  field2: [
    '....oooooooo....', //  0
    '...ohhhhhhhho...', //  1
    '..ohhhhhhhhhho..', //  2
    '..oHhhhhhhhhHo..', //  3
    '..ohhsssssshho..', //  4
    '..ohsessssesho..', //  5
    '..ohcessssecho..', //  6
    '..ohsssmmsssho..', //  7
    '...osssssssso...', //  8
    '....oossssoo....', //  9
    '...obbbbbbbbo...', // 10 плечи
    '..obbbbbbssbo...', // 11 обе кисти тянутся вперёд-вниз
    '..obbbbbbsjbo...', // 12 черенок принят руками
    '..oBbbbbbsjJo...', // 13
    '..osbBbbbbsjJo..', // 14
    '...oppppppppjJ..', // 15 черенок диагональю к земле
    '...oppppppppjJo.', // 16
    '....opppppppjJ..', // 17
    '....oppppppojJ..', // 18
    '....opPppPpojJ..', // 19
    '....oppppppojJ..', // 20 черенок почти у земли
    '....okkkkkkofF..', // 21 лезвие у земли справа от ног
    '....okKkkKkfFF..', // 22 лезвие врезалось в землю
    '....oooooooofF..', // 23
  ],

  // ===== АМБАР — ТАСКАТЬ МЕШКИ (перед грудью → вскинут НАД плечом) =====
  // Силуэт-читаемость: мешок (uU) — крупный бугор, в work2 он ВЫСТУПАЕТ
  // НАД линией головы справа, меняя верхний контур фигуры — «несёт груз».
  // work1: пухлый мешок зерна обхвачен обеими руками перед грудью.
  barn1: [
    '....oooooooo....', //  0
    '...ohhhhhhhho...', //  1
    '..ohhhhhhhhhho..', //  2
    '..oHhhhhhhhhHo..', //  3
    '..ohhsssssshho..', //  4
    '..ohsessssesho..', //  5
    '..ohcessssecho..', //  6
    '..ohsssmmsssho..', //  7
    '...osssssssso...', //  8
    '...ooouuuuooo...', //  9 верх мешка над плечами
    '..obouuuuuuobo..', // 10 мешок выпирает вперёд
    '..obuuUuuUuuubo.', // 11
    '..obuuuuuuuuubo.', // 12 пухлый объём мешка
    '..oBsuUuuuuUusBo', // 13 руки обхватывают по бокам
    '..ossuuuuuuuusso', // 14 кисти снизу держат вес
    '...oUuuuuuuuUo..', // 15 низ мешка у пояса
    '...oppppppppo...', // 16
    '....oppppppo....', // 17
    '....oppppppo....', // 18
    '....opPppPpo....', // 19
    '....oppppppo....', // 20
    '....okkkkkko....', // 21
    '....okKkkKko....', // 22
    '....oooooooo....', // 23
  ],
  // work2: мешок ВСКИНУТ на правое плечо — крупный объём ВЫШЕ головы
  //        и правее (выходит за контур), рука поднята и держит снизу.
  barn2: [
    '..........uuuu..', //  0 верх мешка ВЫШЕ головы справа
    '....oooooouUuuu.', //  1 мешок над плечом
    '...ohhhhhhuuuUu.', //  2
    '..ohhhhhhhuuuuuo', //  3 объём мешка выходит за контур
    '..ohhsssssuUuuuo', //  4
    '..ohsesssseuuuuo', //  5
    '..ohcessssuuuUuo', //  6
    '..ohsssmmssuuuuo', //  7 мешок лежит на плече
    '...osssssssuUuo.', //  8
    '....oossssbsuo..', //  9 рука поднята к мешку
    '...obbbbbbsbo...', // 10 кисть придерживает снизу
    '..obbbbbbbbbbo..', // 11
    '..obbbbbbbbbbo..', // 12
    '..oBbbbbbbbbBo..', // 13
    '..osbBbbbbBbso..', // 14
    '...oppppppppo...', // 15
    '...oppppppppo...', // 16
    '....oppppppo....', // 17
    '....oppppppo....', // 18
    '....opPppPpo....', // 19
    '....oppppppo....', // 20
    '....okkkkkko....', // 21
    '....okKkkKko....', // 22
    '....oooooooo....', // 23
  ],

  // ===== ТЕПЛИЦА — ПОЛИВАТЬ (лейка с носиком → наклон, струя вниз) =====
  // Силуэт-читаемость: корпус лейки (lL) — крупный блок СБОКУ от тела,
  // носик (fF) ВЫНЕСЕН наружу; в work2 носик опущен и из него идёт
  // струя (i) к земле — узнаётся жест «поливаю».
  // work1: лейка поднята сбоку справа, носик торчит наружу горизонтально.
  green1: [
    '....oooooooo....', //  0
    '...ohhhhhhhho...', //  1
    '..ohhhhhhhhhho..', //  2
    '..oHhhhhhhhhHo..', //  3
    '..ohhsssssshho..', //  4
    '..ohsessssesho..', //  5
    '..ohcessssecho..', //  6
    '..ohsssmmsssho..', //  7
    '...osssssssso...', //  8
    '....oossssoo.Lo.', //  9 дужка лейки
    '...obbbbbboLLLo.', // 10 корпус лейки сбоку
    '..obbbbbbBlllLo.', // 11 рука держит за дужку
    'fFooobbbbBlllLo.', // 12 носик торчит наружу влево
    '..oBbbbbbBLllLo.', // 13 корпус лейки
    '..osbBbbbbBLLo..', // 14 низ лейки
    '...oppppppppo...', // 15
    '...oppppppppo...', // 16
    '....oppppppo....', // 17
    '....oppppppo....', // 18
    '....opPppPpo....', // 19
    '....oppppppo....', // 20
    '....okkkkkko....', // 21
    '....okKkkKko....', // 22
    '....oooooooo....', // 23
  ],
  // work2: лейка НАКЛОНЕНА — носик опущен влево-вниз, из него льётся
  //        струя воды (i) к земле; верх корпуса задран (дужка выше).
  green2: [
    '....oooooooo....', //  0
    '...ohhhhhhhho...', //  1
    '..ohhhhhhhhhho..', //  2
    '..oHhhhhhhhhHo..', //  3
    '..ohhsssssshho..', //  4
    '..ohsessssesho..', //  5
    '..ohcessssecho..', //  6
    '..ohsssmmsssho..', //  7
    '...osssssssso...', //  8
    '....oossssooLLo.', //  9 корпус лейки задран
    '...obbbbbbBlLLo.', // 10 рука держит
    '..obbbbbbBlllLo.', // 11
    '..obbbbbbBlllLo.', // 12 корпус наклонён
    '.fFoBbbbbBLllo..', // 13 носик опущен влево-вниз
    'iioosbBbbbLLoo..', // 14 струя пошла из носика
    '.i.oppppppppo...', // 15 струя
    'i..oppppppppo...', // 16 струя
    '.i..oppppppo....', // 17 капля
    'i...oppppppo....', // 18 капля
    '.i..opPppPpo....', // 19
    'i...oppppppo....', // 20 капля у земли
    '....okkkkkko....', // 21
    '....okKkkKko....', // 22
    '....oooooooo....', // 23
  ],

  // ===== РЫНОК — ТОРГОВАТЬ (товар у груди → рука ВЫТЯНУТА с товаром) =====
  // Силуэт-читаемость: в work2 правая рука с товаром (aA) ВЫТЯНУТА
  // далеко вправо за контур тела, над ладонью звенит монета (G) —
  // безошибочный жест «протягиваю товар через прилавок».
  // work1: корзина яблок (aA) обхвачена обеими руками у груди.
  market1: [
    '....oooooooo....', //  0
    '...ohhhhhhhho...', //  1
    '..ohhhhhhhhhho..', //  2
    '..oHhhhhhhhhHo..', //  3
    '..ohhsssssshho..', //  4
    '..ohsessssesho..', //  5
    '..ohcessssecho..', //  6
    '..ohsssmmsssho..', //  7
    '...osssssssso...', //  8
    '....oossssoo....', //  9
    '...obbbbbbbbo...', // 10
    '..oboaaaaaaobo..', // 11 яблоки в обхвате у груди
    '..obaAaaaaAabo..', // 12
    '..oBsaaaaaaasBo.', // 13 руки держат товар
    '..ossoaaaaosso..', // 14 кисти снизу корзины
    '...oppppppppo...', // 15
    '...oppppppppo...', // 16
    '....oppppppo....', // 17
    '....oppppppo....', // 18
    '....opPppPpo....', // 19
    '....oppppppo....', // 20
    '....okkkkkko....', // 21
    '....okKkkKko....', // 22
    '....oooooooo....', // 23
  ],
  // work2: правая рука ВЫТЯНУТА вправо за контур тела — на раскрытой
  //        ладони товар (aA), над ним блестит монета (G).
  market2: [
    '....oooooooo....', //  0
    '...ohhhhhhhho...', //  1
    '..ohhhhhhhhhho..', //  2
    '..oHhhhhhhhhHo..', //  3
    '..ohhsssssshho..', //  4
    '..ohsessssesho..', //  5
    '..ohcessssecho..', //  6
    '..ohsssmmsssho..', //  7
    '...osssssssso...', //  8
    '....oossssoo.G..', //  9 монета звенит над товаром
    '...obbbbbbbboaa.', // 10 рука пошла вправо, товар
    '..obbbbbbbbsaAa.', // 11 предплечье вытянуто
    '..oBbbbbbbsoaao.', // 12 раскрытая ладонь с товаром
    '..osbBbbbbBso...', // 13 плечо
    '...oppppppppo...', // 14
    '...oppppppppo...', // 15
    '....oppppppo....', // 16
    '....oppppppo....', // 17
    '....oppppppo....', // 18
    '....opPppPpo....', // 19
    '....oppppppo....', // 20
    '....okkkkkko....', // 21
    '....okKkkKko....', // 22
    '....oooooooo....', // 23
  ],
};

// Назначение chore-кадров по персонажам (зона → пара кадров).
const WORKER_CHORE = {
  'char-scraper':   'field',
  'char-cleaner':   'field',
  'char-editor':    'barn',
  'char-validator': 'barn',
  'char-runner':    'green',
  'char-sniffer':   'green',
  'char-archiver':  'market',
  'char-signoff':   'market',
};

// Головной убор персонажа, накладываемый поверх рабочего кадра
// (тело уже нарисовано полной сеткой; нужен только head-патч).
const HEADWEAR = new Set(['strawHat', 'headwrap', 'headband', 'glasses']);

// Сборка рабочего кадра: полная сетка позы + головной убор персонажа.
function composeChoreFrame(def, frameName) {
  const base = CHORE_FRAMES[frameName];
  if (!base) throw new Error(`Unknown chore frame: ${frameName}`);
  let grid = base;
  for (const name of def.patches) {
    if (!HEADWEAR.has(name)) continue;
    const patch = PATCHES[name];
    if (!patch) throw new Error(`Unknown patch: ${name}`);
    grid = applyPatch(grid, patch, 0, 0);
  }
  return grid;
}

/* ---------------------------------------------------------------- *
 * Бюст-портрет: верхние строки кадра B (макушка..грудь), лицо крупно.
 * Ручной инвентарь в кадр не попадает — у бюста нет рук.
 * ---------------------------------------------------------------- */

const PORTRAIT_ROWS = 13; // строки 0-12 кадра B: голова, шея, плечи
const PORTRAIT_EXCLUDE = new Set(['pitchfork', 'wateringCan', 'magnifier', 'clipboard', 'box', 'stamp']);

function composePortrait(def) {
  const names = def.patches.filter((name) => !PORTRAIT_EXCLUDE.has(name));
  return composeFrame(BASE_B, names, false).slice(0, PORTRAIT_ROWS);
}

/* ---------------------------------------------------------------- *
 * Персонажи-фермеры: палитра + список патчей.
 * Разные тона кожи и волос; у всех рабочая одежда.
 * ---------------------------------------------------------------- */

const OUTLINE = '#54331a';
const EYES = '#2b2421';

const CHARACTERS = {
  'char-scraper': { // сборщик: соломенная шляпа, комбинезон, сумка для урожая
    patches: ['strawHat', 'overalls', 'satchel'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#8a5a2b', H: '#6b4226', s: '#e8b078', c: '#e0926a', m: '#9c5a48',
      b: '#76a83e', B: '#5d8a30', p: '#4f6d8c', P: '#3d5773',
      k: '#3a2417', K: '#5a3a24',
      y: '#e0bd55', Y: '#bd9638', n: '#4f6d8c', N: '#3d5773',
      t: '#8a5a2b', T: '#6b4226',
    },
  },
  'char-cleaner': { // полевая работница: красная косынка, комбинезон, вилы
    patches: ['headwrap', 'overalls', 'pitchfork'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#2e2018', H: '#1a120c', s: '#f2cfa5', c: '#eda687', m: '#9c5a48',
      b: '#c96f4a', B: '#a8542f', p: '#4f6d8c', P: '#3d5773',
      k: '#3a2417', K: '#5a3a24',
      r: '#b8442e', R: '#8a2f1c', n: '#4f6d8c', N: '#3d5773',
      f: '#b3a99a', d: '#8a5a2b', D: '#6b4226',
    },
  },
  'char-editor': { // амбарный счетовод: шляпа, очки, карандаш, комбинезон
    patches: ['strawHat', 'glasses', 'overalls', 'pencil'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#4a2f1a', H: '#38220f', s: '#c98a5a', c: '#b06a40', m: '#7a4530',
      b: '#5b87a8', B: '#46698a', p: '#4f6d8c', P: '#3d5773',
      k: '#3a2417', K: '#5a3a24',
      y: '#d8b04a', Y: '#b08a2e', g: '#2b2421',
      n: '#4f6d8c', N: '#3d5773', x: '#e3a93a', X: '#3a2417',
    },
  },
  'char-validator': { // приёмщица амбара: красный платок, планшет, комбинезон
    patches: ['kerchief', 'overalls', 'clipboard'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#241a12', H: '#140d08', s: '#8d5524', c: '#a86038', m: '#5f351c',
      b: '#e8d9b0', B: '#cfc090', p: '#4f6d8c', P: '#3d5773',
      k: '#3a2417', K: '#5a3a24',
      r: '#a8431f', R: '#8a3417', n: '#4f6d8c', N: '#3d5773',
      w: '#f6f0dc', W: '#b3a99a',
    },
  },
  'char-runner': { // тепличный садовод: повязка на лоб, комбинезон, лейка
    patches: ['headband', 'overalls', 'wateringCan'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#b5562a', H: '#8f3f1d', s: '#e8b078', c: '#e0926a', m: '#9c5a48',
      b: '#f3ead2', B: '#d9ccab', p: '#4f7d9c', P: '#3c627e',
      k: '#f3ead2', K: '#c96f4a',
      r: '#f6f0dc', R: '#d9ccab', // белая повязка — контраст с рыжими волосами
      n: '#4f7d9c', N: '#3c627e', w: '#8c8478', W: '#5f574e',
    },
  },
  'char-sniffer': { // тепличный инспектор: соломенная шляпа, лупа, комбинезон
    patches: ['strawHat', 'overalls', 'magnifier'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#8c8478', H: '#6e675c', s: '#f2cfa5', c: '#eda687', m: '#9c5a48',
      b: '#b08a52', B: '#93703f', p: '#4f6d8c', P: '#3d5773',
      k: '#3a2417', K: '#5a3a24',
      y: '#e0bd55', Y: '#bd9638', n: '#4f6d8c', N: '#3d5773',
      z: '#b9852e', G: '#cfe6e6', d: '#8a5a2b',
    },
  },
  'char-archiver': { // рыночный носильщик: косынка на шее, ящик с урожаем
    patches: ['kerchief', 'overalls', 'box'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#d8b04a', H: '#b08a2e', s: '#c98a5a', c: '#b06a40', m: '#7a4530',
      b: '#e8d9b0', B: '#cfc090', p: '#4f6d8c', P: '#3d5773',
      k: '#3a2417', K: '#5a3a24',
      r: '#a8431f', R: '#7e2f12', n: '#4f6d8c', N: '#3d5773',
      d: '#c98e4f', D: '#a86f35', x: '#d96c47',
    },
  },
  'char-signoff': { // хозяин прилавка: шляпа, платок, жилет, печать
    patches: ['strawHat', 'kerchief', 'vest', 'stamp'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#d9d2c4', H: '#b3a99a', s: '#f2cfa5', c: '#eda687', m: '#9c5a48',
      b: '#f3ead2', B: '#d9ccab', p: '#4a3b2d', P: '#382c20',
      k: '#3a2417', K: '#5a3a24',
      y: '#e0bd55', Y: '#bd9638', r: '#a8431f', R: '#7e2f12',
      v: '#3a6e1f', d: '#8a5a2b', x: '#a8431f',
    },
  },
  'char-boss': { // Главный Агент: ОРАНЖЕВЫЙ шарф + фермерская шляпа
    patches: ['strawHat', 'orangeScarf'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#3a2417', H: '#271509', s: '#e8b078', c: '#e0926a', m: '#9c5a48',
      b: '#e8d9b0', B: '#cfc090', p: '#6b4a2a', P: '#523620',
      k: '#3a2417', K: '#5a3a24',
      y: '#e0bd55', Y: '#bd9638',
      r: '#d97b29', R: '#b35e17',
    },
  },
};

/* ---------------------------------------------------------------- *
 * Подручные-субагенты: молодые батраки в шляпах и комбинезонах,
 * рубашки разных цветов. Только кадры a/b (без sit и портрета).
 * ---------------------------------------------------------------- */

const HELPERS = {
  'char-helper1': { // терракотовая рубашка
    patches: ['strawHat', 'overalls'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#6b4226', H: '#523620', s: '#e8b078', c: '#e0926a', m: '#9c5a48',
      b: '#c96f4a', B: '#a8542f', p: '#4f6d8c', P: '#3d5773',
      k: '#3a2417', K: '#5a3a24',
      y: '#e0bd55', Y: '#bd9638', n: '#4f6d8c', N: '#3d5773',
    },
  },
  'char-helper2': { // голубая рубашка
    patches: ['strawHat', 'overalls'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#2e2018', H: '#1a120c', s: '#f2cfa5', c: '#eda687', m: '#9c5a48',
      b: '#5b87a8', B: '#46698a', p: '#5a4632', P: '#463524',
      k: '#3a2417', K: '#5a3a24',
      y: '#d8b04a', Y: '#b08a2e', n: '#5a4632', N: '#463524',
    },
  },
  'char-helper3': { // зелёная рубашка
    patches: ['strawHat', 'overalls'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#241a12', H: '#140d08', s: '#8d5524', c: '#a86038', m: '#5f351c',
      b: '#76a83e', B: '#5d8a30', p: '#4f6d8c', P: '#3d5773',
      k: '#3a2417', K: '#5a3a24',
      y: '#e0bd55', Y: '#bd9638', n: '#4f6d8c', N: '#3d5773',
    },
  },
  'char-helper4': { // ягодная рубашка
    patches: ['strawHat', 'overalls'],
    palette: {
      o: OUTLINE, e: EYES,
      h: '#b5562a', H: '#8f3f1d', s: '#c98a5a', c: '#b06a40', m: '#7a4530',
      b: '#c2566e', B: '#9c3f56', p: '#5a4632', P: '#463524',
      k: '#3a2417', K: '#5a3a24',
      y: '#e0bd55', Y: '#bd9638', n: '#5a4632', N: '#463524',
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
 * FX-частицы — крошечные облачка/капли, выбрасываемые при работе.
 * Без чёрного контура (мягкие), палитра согласована со сценой.
 * Каждая 8x8: рисуется поверх грядки/лейки/прилавка и гаснет.
 *   fx-dirt  — бурый пыльный пшик (КОПАТЬ)
 *   fx-water — синие капли воды (ПОЛИВ)
 *   fx-coin  — золотая монетка (ТОРГ)
 *   fx-sheaf — пшеничный сноп/колоски (урожай, общий мотив)
 * ---------------------------------------------------------------- */

const FX = {
  // бурый пыльный пшик — два тона земли, рыхлое облачко
  'fx-dirt': {
    width: 8,
    height: 8,
    palette: { d: '#b98a52', D: '#8a5a2b', l: '#d4b27e' },
    grid: [
      '...l....',
      '.l.dd.l.',
      '.dDddD..',
      'dDddDdDd',
      '.dDddDd.',
      '..dDd...',
      '.l...l..',
      '........',
    ],
  },
  // синие капли воды — три капли разного размера
  'fx-water': {
    width: 8,
    height: 8,
    palette: { i: '#6fb7e0', I: '#3f93c8', w: '#bfe3f4' },
    grid: [
      '..w.....',
      '..i...w.',
      '..I...i.',
      '......I.',
      '.w......',
      '.i...w..',
      '.I...i..',
      '.....I..',
    ],
  },
  // золотая монета — кружок с бликом и буртиком
  'fx-coin': {
    width: 8,
    height: 8,
    palette: { o: '#9c7320', g: '#e3b23a', G: '#f4d873', d: '#b9852e' },
    grid: [
      '..oggo..',
      '.ogGGgo.',
      'ogGGggdo',
      'ogGgggdo',
      'oggggddo',
      'ogdgddo.',
      '.oddddo.',
      '..oddo..',
    ],
  },
  // пшеничный сноп — колоски на стебле, перевязка
  'fx-sheaf': {
    width: 8,
    height: 8,
    palette: { y: '#e0bd55', Y: '#bd9638', g: '#9c7320', t: '#8a5a2b' },
    grid: [
      'y.y..y.y',
      'Yy.yy.yY',
      '.YyYYyY.',
      '..YyyY..',
      '..ytty..',
      '..yttyy.',
      '..ytty..',
      '..g..g..',
    ],
  },
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
    sit: composeSitFrame(def.patches), // сидя за рабочим местом
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

  // Рабочие кадры work1/work2 — чередуются ~3-5 fps, читаются как chore зоны.
  const zone = WORKER_CHORE[id];
  if (zone) {
    const workPalette = { ...def.palette, ...WORK_PALETTE };
    for (const n of [1, 2]) {
      const grid = composeChoreFrame(def, `${zone}${n}`);
      const name = `${id}-work${n}`;
      validateGrid(name, grid, W, H, workPalette);
      if (printMode) printGrid(name, grid);
      writeFileSync(join(OUT, `${name}.svg`), gridToSvg(grid, workPalette, W, H));
      written.push(`${name}.svg`);
    }
  }
}

// Подручные: только кадры a/b.
for (const [id, def] of Object.entries(HELPERS)) {
  const frames = {
    a: composeFrame(BASE_A, def.patches, true),
    b: composeFrame(BASE_B, def.patches, false),
  };
  for (const [suffix, grid] of Object.entries(frames)) {
    const name = `${id}-${suffix}`;
    validateGrid(name, grid, W, H, def.palette);
    if (printMode) printGrid(name, grid);
    writeFileSync(join(OUT, `${name}.svg`), gridToSvg(grid, def.palette, W, H));
    written.push(`${name}.svg`);
  }
}

validateGrid('item-parcel', PARCEL.grid, PARCEL.width, PARCEL.height, PARCEL.palette);
if (printMode) printGrid('item-parcel', PARCEL.grid);
writeFileSync(join(OUT, 'item-parcel.svg'), gridToSvg(PARCEL.grid, PARCEL.palette, PARCEL.width, PARCEL.height));
written.push('item-parcel.svg');

validateGrid('item-paper', PAPER.grid, PAPER.width, PAPER.height, PAPER.palette);
if (printMode) printGrid('item-paper', PAPER.grid);
writeFileSync(join(OUT, 'item-paper.svg'), gridToSvg(PAPER.grid, PAPER.palette, PAPER.width, PAPER.height));
written.push('item-paper.svg');

// FX-частицы (пыль/вода/монета/сноп).
for (const [name, fx] of Object.entries(FX)) {
  validateGrid(name, fx.grid, fx.width, fx.height, fx.palette);
  if (printMode) printGrid(name, fx.grid);
  writeFileSync(join(OUT, `${name}.svg`), gridToSvg(fx.grid, fx.palette, fx.width, fx.height));
  written.push(`${name}.svg`);
}

console.log(`OK: ${written.length} SVG written to ${OUT}`);
for (const f of written) console.log('  ' + f);
