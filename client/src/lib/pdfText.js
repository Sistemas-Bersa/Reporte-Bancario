// ─────────────────────────────────────────────────────────────────────────────
// Extracción de texto de PDF en el NAVEGADOR.
//
// Replica exactamente la lógica del servidor (server/services/bank-extractor/
// base.js) para que el texto enviado a la API sea compatible con los parsers
// (santander.js, etc.). Para páginas escaneadas hace OCR con tesseract.js,
// evitando así el límite de 45s de Azure Static Web Apps (el OCR pesado corre
// aquí, sin timeout, con progreso visible).
// ─────────────────────────────────────────────────────────────────────────────

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url';
import { createWorker, createScheduler } from 'tesseract.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Umbral idéntico al servidor: si el texto digital de la página es menor a esto,
// se considera escaneada y se manda a OCR.
const MIN_DIGITAL_CHARS = 50;

// Escala de render para OCR. PDF base = 72dpi; ×3 ≈ 216dpi.
// A ×3 el OCR captura más renglones (menos filas perdidas) y conserva mejor el
// espaciado de columnas → totales más cercanos al impreso. Más lento que ×2.5
// pero la PRECISIÓN es prioritaria en un extractor bancario.
const OCR_SCALE = 3;

// Nº MÁXIMO de workers Tesseract en paralelo. Se ajusta a los cores del
// dispositivo, dejando uno libre para la UI. Cada worker carga ~30 MB de WASM,
// así que topamos en 6 para no saturar la memoria del navegador.
const OCR_MAX_WORKERS = Math.max(
  2,
  Math.min(6, (navigator.hardwareConcurrency || 4) - 1)
);

/**
 * Reconstruye el texto de una página preservando el espaciado de columnas.
 * PORTADO TAL CUAL desde server/services/bank-extractor/base.js → reconstructText.
 * Crítico: los parsers separan columnas con \s{2,}.
 */
function reconstructText(textContent) {
  const items = textContent.items;
  if (!items.length) return '';

  const Y_TOLERANCE = 3;
  const lineMap = new Map();

  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform[5];

    let matchedY = null;
    for (const existingY of lineMap.keys()) {
      if (Math.abs(existingY - y) <= Y_TOLERANCE) {
        matchedY = existingY;
        break;
      }
    }

    const key = matchedY !== null ? matchedY : y;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key).push({
      x: item.transform[4],
      str: item.str,
      width: item.width || 0
    });
  }

  const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);
  const lines = [];

  for (const y of sortedYs) {
    const words = lineMap.get(y).sort((a, b) => a.x - b.x);
    let line = '';
    let lastEnd = -1;

    for (const word of words) {
      if (lastEnd === -1) {
        line += word.str;
      } else {
        const gap = word.x - lastEnd;
        line += gap > 15 ? '    ' : gap > 1 ? ' ' : '';
        line += word.str;
      }
      lastEnd = word.x + word.width;
    }

    if (line.trim()) lines.push(line);
  }

  return lines.join('\n');
}

// Palabras clave para detectar el banco por el CONTENIDO del PDF (emisor).
// Orden = prioridad. Sólo usa texto digital de las primeras páginas (rápido);
// para PDFs escaneados sin texto, se cae al nombre del archivo / selector manual.
const BANK_CONTENT_KEYWORDS = [
  ['BBVA',      ['BBVA', 'BANCOMER']],
  ['SANTANDER', ['SANTANDER']],
  ['BANAMEX',   ['CITIBANAMEX', 'BANAMEX', 'BANCO NACIONAL DE MEXICO']],
  ['BAJIO',     ['BANBAJIO', 'BANCO DEL BAJIO', 'BAJIO']],
  ['BANORTE',   ['BANORTE', 'MERCANTIL DEL NORTE']],
];

/**
 * Detecta el banco leyendo el texto de las primeras páginas del PDF.
 * @param {File} file
 * @returns {Promise<string|null>}  Clave del banco o null si no se reconoce.
 */
export async function detectBankFromContent(file) {
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const doc  = await pdfjsLib.getDocument({ data }).promise;
    let text = '';
    const n = Math.min(2, doc.numPages);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc   = await page.getTextContent();
      text += ' ' + tc.items.map(it => (typeof it.str === 'string' ? it.str : '')).join(' ');
      await page.cleanup();
    }
    await doc.destroy();

    const upper = text.toUpperCase();
    for (const [bank, kws] of BANK_CONTENT_KEYWORDS) {
      if (kws.some(k => upper.includes(k))) return bank;
    }
  } catch { /* ignorar: se usará nombre/selector */ }
  return null;
}

// Scheduler Tesseract compartido (lazy) con un pool de workers para procesar
// varias páginas en paralelo. Se crea una vez por sesión y se reutiliza.
let _scheduler   = null;
let _workerCount = 0;
let _growLock    = null;   // serializa el crecimiento del pool

/**
 * Devuelve el scheduler asegurando que tenga al menos `want` workers
 * (tope OCR_MAX_WORKERS). Crea los workers de forma incremental: un PDF con
 * pocas páginas escaneadas no levanta 6 cores; uno grande sí escala.
 */
async function getScheduler(want = 1) {
  const target = Math.min(OCR_MAX_WORKERS, Math.max(1, want));

  if (!_scheduler) _scheduler = createScheduler();

  // Serializar para no crear de más si se llama en paralelo
  while (_growLock) await _growLock;

  if (_workerCount < target) {
    _growLock = (async () => {
      const toAdd = target - _workerCount;
      const newWorkers = await Promise.all(
        Array.from({ length: toAdd }, () => createWorker('spa'))
      );
      newWorkers.forEach(w => _scheduler.addWorker(w));
      _workerCount += newWorkers.length;
    })();
    try { await _growLock; } finally { _growLock = null; }
  }

  return _scheduler;
}

/** Libera el pool de workers Tesseract (opcional, al terminar todo). */
export async function terminateOcr() {
  if (_scheduler) {
    try { await _scheduler.terminate(); } catch { /* noop */ }
    _scheduler   = null;
    _workerCount = 0;
    _growLock    = null;
  }
}

/**
 * Renderiza una página del PDF a un canvas y lo devuelve.
 *
 * NOTA: NO preprocesamos la imagen (grises/contraste). Tesseract ya hace su
 * propia binarización (Otsu) internamente; darle una imagen pre-contrastada
 * lo confunde y pierde renglones. En pruebas, la imagen CRUDA a escala 3
 * dio ~−2% vs total impreso, mientras que con preprocesado caía a ~−19%.
 */
async function renderPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas   = document.createElement('canvas');
  canvas.width   = Math.ceil(viewport.width);
  canvas.height  = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/**
 * Extrae el texto de todas las páginas de un PDF (File del navegador).
 * Para páginas escaneadas hace OCR. Devuelve { pages, usedOcr }.
 *
 * @param {File} file
 * @param {(info:{page:number,total:number,phase:'text'|'ocr'})=>void} onProgress
 * @returns {Promise<{ pages: string[], usedOcr: boolean }>}
 */
export async function extractFilePages(file, onProgress = () => {}) {
  const buf  = await file.arrayBuffer();
  const data = new Uint8Array(buf);
  const doc  = await pdfjsLib.getDocument({ data }).promise;
  const total = doc.numPages;

  const pages   = new Array(total).fill('');
  const ocrJobs = [];   // índices de páginas que requieren OCR
  let   usedOcr = false;

  try {
    // ── Paso 1: texto digital de todas las páginas (rápido, secuencial) ──────
    for (let i = 0; i < total; i++) {
      const page = await doc.getPage(i + 1);
      const tc   = await page.getTextContent();
      const text = reconstructText(tc);
      await page.cleanup();

      if (text.trim().length >= MIN_DIGITAL_CHARS) {
        pages[i] = text;
      } else {
        ocrJobs.push(i);
      }
    }

    // ── Paso 2: OCR con CONCURRENCIA ACOTADA (render + recognize por slot) ────
    // Nº de slots = nº de páginas a OCR, topado en OCR_MAX_WORKERS. Así un PDF
    // con 2 páginas escaneadas usa 2 workers, y uno de 56 usa el máximo.
    // Limitar los slots evita además tener decenas de canvas en memoria a la vez.
    if (ocrJobs.length > 0) {
      usedOcr = true;
      const slots     = Math.min(OCR_MAX_WORKERS, ocrJobs.length);
      const scheduler = await getScheduler(slots);

      let done = 0;
      let next = 0;
      onProgress({ page: 0, total: ocrJobs.length, phase: 'ocr' });

      async function runSlot() {
        while (next < ocrJobs.length) {
          const i = ocrJobs[next++];
          const page   = await doc.getPage(i + 1);
          const canvas = await renderPageToCanvas(page, OCR_SCALE);
          await page.cleanup();

          const { data: { text: ocrText } } = await scheduler.addJob('recognize', canvas);
          pages[i] = ocrText || '';
          canvas.width = canvas.height = 0;   // liberar memoria

          done++;
          onProgress({ page: done, total: ocrJobs.length, phase: 'ocr' });
        }
      }

      await Promise.all(Array.from({ length: slots }, runSlot));
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  return { pages, usedOcr };
}
