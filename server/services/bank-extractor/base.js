'use strict';

const fs = require('fs');

class BankExtractorBase {
  /**
   * @param {string}        pdfPath   Ruta al PDF (o solo el nombre si pageTexts viene dado)
   * @param {Function}      logger    Función de log
   * @param {string[]|null} pageTexts Si se provee, se OMITE pdfjs+OCR y se usan
   *                                   estos textos por página (OCR hecho en el cliente)
   */
  constructor(pdfPath, logger = console.log, pageTexts = null) {
    this.pdfPath = pdfPath;
    this.transactions = [];
    this.usedOcr = false;
    this.onOcrCallback = null;
    this.onOcrPageCallback = null;
    this._logger = logger;
    this._log = (...args) => logger('[bank-extractor]', ...args);
    this._pageTexts = Array.isArray(pageTexts) ? pageTexts : null;

    // Solo exigimos el archivo cuando vamos a leerlo (modo OCR servidor).
    if (!this._pageTexts && !fs.existsSync(pdfPath)) {
      throw new Error(`El archivo no existe: ${pdfPath}`);
    }
  }

  async *iteratePages() {
    const TAG = `[base][${require('path').basename(this.pdfPath)}]`;

    // ── Modo texto provisto (OCR hecho en el navegador) ──────────────────────
    if (this._pageTexts) {
      this._log(`${TAG} Modo texto-provisto: ${this._pageTexts.length} páginas (sin OCR servidor)`);
      for (const text of this._pageTexts) yield text || '';
      return;
    }

    this._log(`${TAG} iteratePages() — cargando pdfjs-dist…`);

    let pdfjsLib;
    try {
      pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
      this._log(`${TAG} pdfjs-dist cargado OK`);
    } catch (e) {
      this._log(`${TAG} ERROR al cargar pdfjs-dist: ${e.message} ${e.stack}`);
      throw e;
    }

    let data;
    try {
      data = new Uint8Array(fs.readFileSync(this.pdfPath));
      this._log(`${TAG} Archivo leído: ${data.length} bytes`);
    } catch (e) {
      this._log(`${TAG} ERROR al leer el archivo: ${e.message}`);
      throw e;
    }

    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data }).promise;
      this._log(`${TAG} PDF abierto: ${doc.numPages} páginas`);
    } catch (e) {
      this._log(`${TAG} ERROR en getDocument(): ${e.message} ${e.stack}`);
      throw e;
    }

    const totalPages = doc.numPages;

    // ── Paso 1: extraer texto digital de todas las páginas (rápido) ──────────
    const pageTexts  = new Array(totalPages).fill('');
    const ocrIndexes = [];

    for (let i = 0; i < totalPages; i++) {
      try {
        const page = await doc.getPage(i + 1);
        const tc   = await page.getTextContent();
        const text = reconstructText(tc);
        pageTexts[i] = text;
        const len = text.trim().length;
        if (len < 50) {
          ocrIndexes.push(i);
          this._log(`${TAG} Página ${i + 1}: texto digital insuficiente (${len} chars) → OCR pendiente`);
        } else {
          this._log(`${TAG} Página ${i + 1}: ${len} chars de texto digital`);
        }
      } catch (e) {
        this._log(`${TAG} ERROR en página ${i + 1}: ${e.message}`);
        throw e;
      }
    }
    await doc.destroy();
    this._log(`${TAG} PDF liberado. Páginas OCR necesarias: ${ocrIndexes.length}`);

    // ── Paso 2: OCR en paralelo (lotes de 4 páginas) — ~4x más rápido ───────
    if (ocrIndexes.length > 0) {
      this.usedOcr = true;
      this._log(`${TAG} OCR activado: ${ocrIndexes.length} páginas escaneadas`);
      if (this.onOcrCallback) this.onOcrCallback();

      let ocrPage, terminateOcrWorker;
      try {
        ({ ocrPage, terminateOcrWorker } = require('./ocr-utils'));
        this._log(`${TAG} ocr-utils cargado OK`);
      } catch (e) {
        this._log(`${TAG} ERROR al cargar ocr-utils: ${e.message} ${e.stack}`);
        throw e;
      }

      // En Azure Functions: batch=1 (1 página a la vez) para no exceder RAM.
      // Local: batch=4 (~4× más rápido).
      const BATCH = process.env.FUNCTIONS_WORKER_RUNTIME ? 1 : 4;
      this._log(`${TAG} BATCH OCR = ${BATCH} (FUNCTIONS_WORKER_RUNTIME=${process.env.FUNCTIONS_WORKER_RUNTIME || 'no'})`);

      try {
        for (let b = 0; b < ocrIndexes.length; b += BATCH) {
          const batch = ocrIndexes.slice(b, b + BATCH);
          this._log(`${TAG} OCR páginas ${batch.map(x => x + 1).join(', ')} / ${totalPages}…`);

          let results;
          try {
            results = await Promise.all(
              batch.map(idx => {
                if (this.onOcrPageCallback) this.onOcrPageCallback(idx + 1, totalPages);
                return ocrPage(this.pdfPath, idx, this._logger);
              })
            );
            batch.forEach((idx, j) => {
              pageTexts[idx] = results[j];
              this._log(`${TAG} OCR página ${idx + 1}: ${(results[j] || '').trim().length} chars`);
            });
          } catch (e) {
            this._log(`${TAG} ERROR en OCR batch [${batch.map(x => x + 1).join(',')}]: ${e.message} ${e.stack}`);
            throw e;
          }
        }
      } finally {
        // Liberar el worker Tesseract al terminar todo el lote
        await terminateOcrWorker();
        this._log(`${TAG} Worker Tesseract terminado`);
      }
    }

    // ── Paso 3: yield en orden ────────────────────────────────────────────────
    for (const text of pageTexts) yield text;
  }

  async extractTransactions() {
    throw new Error('extractTransactions() debe ser implementado por la clase hija.');
  }
}

/**
 * Reconstruye el texto de una página preservando el espaciado de columnas.
 * pdfjs-dist devuelve items sueltos; agrupamos por Y y separamos con espacios
 * proporcionales al gap horizontal — crítico para los parsers que usan \s{2,}.
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

  // PDF coords son bottom-up, así que ordenamos Y descendente
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
        // Gap > 15pt = separación de columnas → 4 espacios (compatible con \s{2,})
        line += gap > 15 ? '    ' : gap > 1 ? ' ' : '';
        line += word.str;
      }
      lastEnd = word.x + word.width;
    }

    if (line.trim()) lines.push(line);
  }

  return lines.join('\n');
}

module.exports = { BankExtractorBase };
