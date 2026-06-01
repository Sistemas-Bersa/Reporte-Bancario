'use strict';
// Verifica que los totales por banco cuadren tras el refactor de OCR-en-navegador.
// Para cada PDF de muestra:
//   1. Corre el pipeline original (extractTransactions) capturando el texto por
//      página en UNA sola pasada de OCR.
//   2. Corre el nuevo camino (extractTransactionsFromText) con ese mismo texto.
//   3. Compara que produzcan EXACTAMENTE las mismas transacciones.
//
// Uso:  node diagnostics/verify-totals.js

const path = require('path');
const fs   = require('fs');

const {
  detectBank,
  extractTransactionsFromText
} = require('../services/bank-extractor');
const banks = require('../services/bank-extractor/banks');

const BANK_MAP = {
  BBVA:      banks.BBVAExtractor,
  SANTANDER: banks.SantanderExtractor,
  BANAMEX:   banks.BanamexExtractor,
  BAJIO:     banks.BajioExtractor,
  BANORTE:   banks.BanorteExtractor
};

const SAMPLES_DIR = path.join(__dirname, '../../pdfs_muestra');

function listPdfs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...listPdfs(full));
    else if (name.toLowerCase().endsWith('.pdf')) out.push(full);
  }
  return out;
}

function toNum(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/,/g, '')) || 0;
}

function summarize(txs) {
  let dep = 0, ret = 0;
  for (const t of txs) {
    dep += toNum(t['MONTO DEPOSITOS']);
    ret += toNum(t['MONTO RETIROS']);
  }
  const saldoFinal = txs.length ? txs[txs.length - 1]['SALDO'] : '';
  return { count: txs.length, dep, ret, saldoFinal };
}

function fmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

(async () => {
  const filter = process.argv[2];   // opcional: subcadena del nombre a filtrar
  let pdfs = listPdfs(SAMPLES_DIR);
  if (filter) pdfs = pdfs.filter(p => path.basename(p).toUpperCase().includes(filter.toUpperCase()));
  console.log(`\nVerificando ${pdfs.length} PDFs de muestra${filter ? ` (filtro: ${filter})` : ''}…\n`);

  let allMatch = true;

  for (const pdfPath of pdfs) {
    const name = path.basename(pdfPath);
    const bank = detectBank(name);
    if (!bank) { console.log(`⏭  ${name}: banco no identificado`); continue; }

    const Extractor = BANK_MAP[bank];
    const e = new Extractor(pdfPath, () => {});

    // TEE: capturar el texto por página mientras corre el pipeline original
    const realIterate = e.iteratePages.bind(e);
    const captured = [];
    e.iteratePages = async function* () {
      for await (const t of realIterate()) { captured.push(t); yield t; }
    };

    const t0 = Date.now();
    let ref;
    try {
      ref = await e.extractTransactions();
    } catch (err) {
      console.log(`❌ ${name} (${bank}): ERROR pipeline original — ${err.message}`);
      allMatch = false;
      continue;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // Bancos que NO usan iteratePages (BBVA/BANAMEX/BANORTE → posiciones X):
    // no soportan inyección de texto, van por el endpoint original del servidor.
    if (captured.length === 0) {
      const a = summarize(ref);
      console.log(`➖ ${name}`);
      console.log(`    Banco: ${bank} | posiciones-X (servidor) | ${secs}s`);
      console.log(`    Original  → ${a.count} tx | Dep ${fmt(a.dep)} | Ret ${fmt(a.ret)} | Saldo final ${a.saldoFinal}`);
      console.log(`    (no aplica camino-texto — usa coordenadas del PDF)\n`);
      continue;
    }

    // Nuevo camino con el MISMO texto capturado
    let textRes;
    try {
      textRes = await extractTransactionsFromText(name, captured, { usedOcr: e.usedOcr, logger: () => {} });
    } catch (err) {
      console.log(`❌ ${name} (${bank}): ERROR camino-texto — ${err.message}`);
      allMatch = false;
      continue;
    }

    const a = summarize(ref);
    const b = summarize(textRes);
    const equal = JSON.stringify(ref) === JSON.stringify(textRes);
    if (!equal) allMatch = false;

    const ocrTag = e.usedOcr ? `OCR(${captured.length}p)` : 'digital';
    console.log(
      `${equal ? '✅' : '❌'} ${name}`
    );
    console.log(
      `    Banco: ${bank} | ${ocrTag} | ${secs}s`
    );
    console.log(
      `    Original  → ${a.count} tx | Dep ${fmt(a.dep)} | Ret ${fmt(a.ret)} | Saldo final ${a.saldoFinal}`
    );
    console.log(
      `    Texto     → ${b.count} tx | Dep ${fmt(b.dep)} | Ret ${fmt(b.ret)} | Saldo final ${b.saldoFinal}`
    );
    if (!equal) console.log(`    ⚠ LAS TRANSACCIONES NO COINCIDEN`);
    console.log('');
  }

  console.log(allMatch
    ? '✅ TODOS los bancos cuadran: el camino de texto produce resultados idénticos.\n'
    : '❌ Hay diferencias — revisar arriba.\n');
  process.exit(allMatch ? 0 : 1);
})();
