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
import { createWorker } from 'tesseract.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Umbral idéntico al servidor: si el texto digital de la página es menor a esto,
// se considera escaneada y se manda a OCR.
const MIN_DIGITAL_CHARS = 50;

// Escala de render para OCR. PDF base = 72dpi; ×2 ≈ 144dpi (buena precisión).
const OCR_SCALE = 2;

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

// Worker Tesseract compartido (lazy) — se crea una vez por sesión.
let _ocrWorker = null;
async function getOcrWorker() {
  if (_ocrWorker) return _ocrWorker;
  _ocrWorker = await createWorker('spa');
  return _ocrWorker;
}

/** Libera el worker Tesseract (opcional, al terminar todo). */
export async function terminateOcr() {
  if (_ocrWorker) {
    try { await _ocrWorker.terminate(); } catch { /* noop */ }
    _ocrWorker = null;
  }
}

/** Renderiza una página del PDF a un canvas y devuelve el canvas. */
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
  let   usedOcr = false;

  try {
    for (let i = 0; i < total; i++) {
      const page = await doc.getPage(i + 1);
      const tc   = await page.getTextContent();
      const text = reconstructText(tc);

      if (text.trim().length >= MIN_DIGITAL_CHARS) {
        // Página con texto digital → no requiere OCR
        pages[i] = text;
        onProgress({ page: i + 1, total, phase: 'text' });
      } else {
        // Página escaneada → OCR en el navegador
        usedOcr = true;
        onProgress({ page: i + 1, total, phase: 'ocr' });
        const canvas = await renderPageToCanvas(page, OCR_SCALE);
        const worker = await getOcrWorker();
        const { data: { text: ocrText } } = await worker.recognize(canvas);
        pages[i] = ocrText || '';
        // Liberar el canvas
        canvas.width = canvas.height = 0;
      }
      await page.cleanup();
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  return { pages, usedOcr };
}
