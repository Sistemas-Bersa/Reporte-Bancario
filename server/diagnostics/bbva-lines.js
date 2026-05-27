'use strict';
/**
 * Vuelca las líneas reconstruidas de las primeras páginas del PDF BBVA
 * para ver la estructura real de columnas (CARGOS vs ABONOS).
 */

const path = require('path');
const fs   = require('fs');

const PDF = path.join(__dirname,
  '../../pdfs_muestra/BERSA BBVA JULIO 2024.pdf');

// ── copia de reconstructText (igual que base.js) ──────────────────────────
function reconstructText(textContent) {
  const items = textContent.items;
  if (!items.length) return '';
  const Y_TOLERANCE = 3;
  const lineMap = new Map();
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform[5];
    let matchedY = null;
    for (const ey of lineMap.keys()) {
      if (Math.abs(ey - y) <= Y_TOLERANCE) { matchedY = ey; break; }
    }
    const key = matchedY !== null ? matchedY : y;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key).push({ x: item.transform[4], str: item.str, width: item.width || 0 });
  }
  const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);
  const lines = [];
  for (const y of sortedYs) {
    const words = lineMap.get(y).sort((a, b) => a.x - b.x);
    let line = ''; let lastEnd = -1;
    for (const w of words) {
      if (lastEnd === -1) { line += w.str; }
      else {
        const gap = w.x - lastEnd;
        line += gap > 15 ? '    ' : gap > 1 ? ' ' : '';
        line += w.str;
      }
      lastEnd = w.x + w.width;
    }
    if (line.trim()) lines.push(line);
  }
  return lines.join('\n');
}

// ── También necesitamos ver las posiciones X exactas de los montos ─────────
function dumpWithPositions(textContent, pageNum) {
  const items = textContent.items;
  const Y_TOLERANCE = 3;
  const lineMap = new Map();
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform[5];
    let matchedY = null;
    for (const ey of lineMap.keys()) {
      if (Math.abs(ey - y) <= Y_TOLERANCE) { matchedY = ey; break; }
    }
    const key = matchedY !== null ? matchedY : y;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key).push({ x: item.transform[4], str: item.str, width: item.width || 0 });
  }
  const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);
  const amountRe = /^\d{1,3}(,\d{3})*\.\d{2}$/;

  console.log(`\n=== Página ${pageNum}: posiciones X de montos ===`);
  for (const y of sortedYs) {
    const words = lineMap.get(y).sort((a, b) => a.x - b.x);
    const amounts = words.filter(w => amountRe.test(w.str.replace(/\s/g, '')));
    if (amounts.length) {
      const line = words.map(w => w.str).join(' ');
      amounts.forEach(a => {
        console.log(`  x=${a.x.toFixed(1).padStart(6)}  val=${a.str.padStart(14)}  línea: ${line.slice(0, 70)}`);
      });
    }
  }
}

async function main() {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(PDF));
  const doc  = await pdfjsLib.getDocument({ data }).promise;

  console.log(`PDF: ${path.basename(PDF)}  (${doc.numPages} páginas)\n`);

  // ── Muestra líneas reconstruidas de páginas 2-5 ─────────────────────
  for (let i = 2; i <= Math.min(5, doc.numPages); i++) {
    const page = await doc.getPage(i);
    const tc   = await page.getTextContent();
    const text = reconstructText(tc);

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`LÍNEAS RECONSTRUIDAS — Página ${i}`);
    console.log('─'.repeat(70));
    for (const line of text.split('\n').slice(0, 40)) {
      console.log(JSON.stringify(line));  // JSON para ver espacios exactos
    }

    // También muestra posiciones X de los montos
    dumpWithPositions(tc, i);
  }

  await doc.destroy();
}

main().catch(console.error);
