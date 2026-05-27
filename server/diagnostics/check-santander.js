'use strict';
/**
 * Diagnóstico: ejecuta el extractor Santander en todos los PDFs disponibles
 * y muestra: total retiros, total depósitos, conteo, y primeras/últimas 5 filas.
 *
 * Uso: node server/diagnostics/check-santander.js
 */

const path = require('path');
const fs   = require('fs');
const { SantanderExtractor } = require('../services/bank-extractor/banks/santander');

const PDF_DIR = path.join(__dirname, '../../pdfs_muestra');

function toFloat(val) {
  if (!val) return 0;
  return parseFloat(String(val).replace(/,/g, '')) || 0;
}

async function checkPdf(pdfPath) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`PDF: ${path.basename(pdfPath)}`);
  console.log('='.repeat(70));

  try {
    const extractor = new SantanderExtractor(pdfPath);
    const txs = await extractor.extractTransactions();

    if (!txs.length) {
      console.log('  ⚠  Sin transacciones extraídas.');
      return;
    }

    const totalRetiros  = txs.reduce((s, t) => s + toFloat(t['MONTO RETIROS']),   0);
    const totalDepositos = txs.reduce((s, t) => s + toFloat(t['MONTO DEPOSITOS']), 0);

    console.log(`  Transacciones : ${txs.length}`);
    console.log(`  Total Retiros : ${totalRetiros.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
    console.log(`  Total Depósitos: ${totalDepositos.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
    console.log(`  OCR usado     : ${extractor.usedOcr}`);

    console.log('\n  --- Primeras 5 transacciones ---');
    txs.slice(0, 5).forEach((t, i) => {
      console.log(`  [${i+1}] ${t['FECHA']}  |  Ref: ${t['REFERENCIA']?.padEnd(10)}  |  ${t['CONCEPTO']?.slice(0,35).padEnd(35)}  |  R: ${String(t['MONTO RETIROS']).padStart(14)}  |  D: ${String(t['MONTO DEPOSITOS']).padStart(14)}  |  S: ${t['SALDO']}`);
    });

    console.log('\n  --- Últimas 5 transacciones ---');
    txs.slice(-5).forEach((t, i) => {
      console.log(`  [${txs.length - 4 + i}] ${t['FECHA']}  |  Ref: ${t['REFERENCIA']?.padEnd(10)}  |  ${t['CONCEPTO']?.slice(0,35).padEnd(35)}  |  R: ${String(t['MONTO RETIROS']).padStart(14)}  |  D: ${String(t['MONTO DEPOSITOS']).padStart(14)}  |  S: ${t['SALDO']}`);
    });

    // Mostrar duplicados si los hay
    const seen = new Map();
    const dups = [];
    for (const t of txs) {
      const key = `${t['FECHA']}|${t['REFERENCIA']}|${t['MONTO RETIROS']}|${t['MONTO DEPOSITOS']}`;
      if (seen.has(key)) dups.push(t);
      else seen.set(key, t);
    }
    if (dups.length) {
      console.log(`\n  ⚠  ${dups.length} DUPLICADOS detectados:`);
      dups.slice(0,10).forEach(t => {
        console.log(`     ${t['FECHA']}  |  ${t['CONCEPTO']?.slice(0,40)}  |  R: ${t['MONTO RETIROS']}  |  D: ${t['MONTO DEPOSITOS']}`);
      });
    }

  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
  }
}

async function main() {
  // Buscar todos los PDFs Santander recursivamente
  function findPdfs(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findPdfs(full));
      } else if (entry.name.toLowerCase().endsWith('.pdf') &&
                 /SANTA?N?DER/i.test(entry.name)) {
        results.push(full);
      }
    }
    return results;
  }

  const pdfs = findPdfs(PDF_DIR);
  if (!pdfs.length) {
    console.log('No se encontraron PDFs Santander en', PDF_DIR);
    return;
  }

  console.log(`Encontrados ${pdfs.length} PDF(s) Santander:`);
  pdfs.forEach(p => console.log('  •', path.basename(p)));

  for (const p of pdfs) {
    await checkPdf(p);
  }

  console.log('\n\nDIAGNÓSTICO COMPLETADO');
}

main().catch(console.error);
