'use strict';

const fs = require('fs');

class BankExtractorBase {
  constructor(pdfPath) {
    this.pdfPath = pdfPath;
    this.transactions = [];
    this.usedOcr = false;
    this.onOcrCallback = null;
    this.onOcrPageCallback = null;

    if (!fs.existsSync(pdfPath)) {
      throw new Error(`El archivo no existe: ${pdfPath}`);
    }
  }

  async *iteratePages() {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const data = new Uint8Array(fs.readFileSync(this.pdfPath));
    const doc  = await pdfjsLib.getDocument({ data }).promise;
    const totalPages = doc.numPages;

    // ── Paso 1: extraer texto digital de todas las páginas (rápido) ──────────
    const pageTexts  = new Array(totalPages).fill('');
    const ocrIndexes = [];

    for (let i = 0; i < totalPages; i++) {
      const page = await doc.getPage(i + 1);
      const tc   = await page.getTextContent();
      const text = reconstructText(tc);
      pageTexts[i] = text;
      if (text.trim().length < 50) ocrIndexes.push(i);
    }
    await doc.destroy();

    // ── Paso 2: OCR en paralelo (lotes de 4 páginas) — ~4x más rápido ───────
    if (ocrIndexes.length > 0) {
      this.usedOcr = true;
      console.log(`OCR activado: ${ocrIndexes.length} páginas escaneadas en ${this.pdfPath}`);
      if (this.onOcrCallback) this.onOcrCallback();

      const { ocrPage } = require('./ocr-utils');
      const BATCH = 4;

      for (let b = 0; b < ocrIndexes.length; b += BATCH) {
        const batch = ocrIndexes.slice(b, b + BATCH);
        console.log(`  OCR páginas ${batch.map(x => x + 1).join(', ')} / ${totalPages}…`);

        const results = await Promise.all(
          batch.map(idx => {
            if (this.onOcrPageCallback) this.onOcrPageCallback(idx + 1, totalPages);
            return ocrPage(this.pdfPath, idx);
          })
        );

        batch.forEach((idx, j) => { pageTexts[idx] = results[j]; });
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
