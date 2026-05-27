'use strict';
/**
 * Diagnóstico BBVA:
 * 1. Vuelca las primeras 80 líneas de texto crudo del PDF (para ver el formato real)
 * 2. Corre el extractor y muestra totales + primeras/últimas filas
 * 3. Detecta transacciones sin clasificar (sin monto en ninguna columna)
 */

const path = require('path');
const fs   = require('fs');
const { BBVAExtractor } = require('../services/bank-extractor/banks/bbva');

const PDF_DIR = path.join(__dirname, '../../pdfs_muestra');

function findBBVA(dir) {
  const results = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) results.push(...findBBVA(full));
    else if (e.name.toLowerCase().endsWith('.pdf') && /bbva/i.test(e.name))
      results.push(full);
  }
  return results;
}

function toFloat(v) {
  if (!v) return 0;
  return parseFloat(String(v).replace(/,/g, '')) || 0;
}

async function dumpRawText(pdfPath) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc  = await pdfjsLib.getDocument({ data }).promise;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`TEXTO CRUDO (primeras 5 páginas): ${path.basename(pdfPath)}`);
  console.log('─'.repeat(70));

  for (let i = 1; i <= Math.min(5, doc.numPages); i++) {
    const page = await doc.getPage(i);
    const tc   = await page.getTextContent();
    const text = tc.items.map(x => x.str).join(' ');
    console.log(`\n--- Página ${i} (raw items, primeros 600 chars) ---`);
    console.log(text.slice(0, 600));
  }
  await doc.destroy();
}

async function main() {
  const pdfs = findBBVA(PDF_DIR);
  if (!pdfs.length) { console.log('No se encontraron PDFs BBVA en', PDF_DIR); return; }

  for (const pdf of pdfs) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`PDF: ${path.basename(pdf)}`);
    console.log('='.repeat(70));

    // ── 1. Texto crudo ──────────────────────────────────────────────────
    await dumpRawText(pdf);

    // ── 2. Extracción ───────────────────────────────────────────────────
    const extractor = new BBVAExtractor(pdf);
    const txs = await extractor.extractTransactions();

    const totalC = txs.reduce((s, t) => s + toFloat(t['Monto Cargo']),  0);
    const totalA = txs.reduce((s, t) => s + toFloat(t['Monto Abono']), 0);
    const sinClasif = txs.filter(t => !t['Monto Cargo'] && !t['Monto Abono']);

    console.log(`\n── Extracción ──`);
    console.log(`  Transacciones   : ${txs.length}`);
    console.log(`  Sin clasificar  : ${sinClasif.length}`);
    console.log(`  Total Cargos    : ${totalC.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
    console.log(`  Total Abonos    : ${totalA.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);

    console.log('\n  ── Primeras 10 transacciones ──');
    txs.slice(0, 10).forEach((t, i) => {
      console.log(`  [${String(i+1).padStart(3)}] ${t['Fecha Operacion']} | ${String(t['Codigo']||'').padEnd(12)} | ${String(t['Concepto']||'').slice(0,40).padEnd(40)} | C:${String(t['Monto Cargo']||'').padStart(12)} | A:${String(t['Monto Abono']||'').padStart(12)}`);
    });

    console.log('\n  ── Últimas 5 transacciones ──');
    txs.slice(-5).forEach((t, i) => {
      console.log(`  [${String(txs.length-4+i).padStart(3)}] ${t['Fecha Operacion']} | ${String(t['Codigo']||'').padEnd(12)} | ${String(t['Concepto']||'').slice(0,40).padEnd(40)} | C:${String(t['Monto Cargo']||'').padStart(12)} | A:${String(t['Monto Abono']||'').padStart(12)}`);
    });

    if (sinClasif.length) {
      console.log(`\n  ── Primeros 10 sin clasificar ──`);
      sinClasif.slice(0, 10).forEach(t => {
        console.log(`     ${t['Fecha Operacion']} | ${t['Codigo']} | ${String(t['Concepto']||'').slice(0,60)}`);
      });
    }

    // ── 3. Muestra conceptos únicos de ABONOS detectados ────────────────
    const abonos = txs.filter(t => t['Monto Abono']).map(t => t['Concepto'].split(' ')[0]);
    const uniqueAbonos = [...new Set(abonos)].sort();
    console.log('\n  ── Palabras iniciales de ABONOS clasificados ──');
    console.log('  ', uniqueAbonos.slice(0, 20).join(', '));
  }
}

main().catch(console.error);
