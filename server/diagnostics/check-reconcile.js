'use strict';
// Corre el pipeline en un PDF y reporta la reconciliación (extraído vs TOTAL impreso).
// Uso: node diagnostics/check-reconcile.js "<subcadena del nombre>"
const path = require('path');
const fs   = require('fs');
const s    = require('../services/bank-extractor');
const banks = require('../services/bank-extractor/banks');
const BANK_MAP = {
  BBVA: banks.BBVAExtractor, SANTANDER: banks.SantanderExtractor,
  BANAMEX: banks.BanamexExtractor, BAJIO: banks.BajioExtractor, BANORTE: banks.BanorteExtractor
};
const DIR = path.join(__dirname, '../../pdfs_muestra');
function list(d){const o=[];for(const n of fs.readdirSync(d)){const f=path.join(d,n);if(fs.statSync(f).isDirectory())o.push(...list(f));else if(n.toLowerCase().endsWith('.pdf'))o.push(f);}return o;}

(async () => {
  const filter = (process.argv[2] || '').toUpperCase();
  const pdf = list(DIR).find(p => path.basename(p).toUpperCase().includes(filter));
  if (!pdf) { console.log('No se encontró PDF con:', filter); process.exit(1); }
  const name = path.basename(pdf);
  const bank = s.detectBank(name);
  const e = new BANK_MAP[bank](pdf, () => {});
  const realIterate = e.iteratePages.bind(e);
  const captured = [];
  e.iteratePages = async function*(){ for await (const t of realIterate()){ captured.push(t); yield t; } };

  console.log(`\nProcesando ${name} (${bank})…`);
  const t0 = Date.now();
  const tx = await e.extractTransactions();
  console.log(`Listo en ${((Date.now()-t0)/1000).toFixed(0)}s — ${tx.length} transacciones`);

  // Cachear el texto OCR por página para poder experimentar sin re-OCR
  const cacheFile = path.join(__dirname, `texts-${bank}-${(filter||'pdf').replace(/\W+/g,'_')}.json`);
  fs.writeFileSync(cacheFile, JSON.stringify({ name, bank, pages: captured }));
  console.log(`Texto OCR cacheado en ${path.basename(cacheFile)}`);

  const r = s.reconcileTotals(tx, captured);
  if (!r) { console.log('No se halló línea TOTAL.'); process.exit(0); }
  const f = n => Number(n).toLocaleString('en-US',{minimumFractionDigits:2});
  console.log('\n── Reconciliación ──');
  console.log(`Depósitos: extraído ${f(r.extractedDep)} | impreso ${f(r.printedDep)} | ${r.okDep ? '✅ cuadra' : '❌ difiere ' + f(r.extractedDep - r.printedDep)}`);
  console.log(`Retiros:   extraído ${f(r.extractedRet)} | impreso ${f(r.printedRet)} | ${r.okRet ? '✅ cuadra' : '❌ difiere ' + f(r.extractedRet - r.printedRet)}`);
  console.log(`Estado: ${r.status}\n`);
})();
