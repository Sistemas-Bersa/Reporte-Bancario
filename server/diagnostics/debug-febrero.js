'use strict';
/**
 * Diagnóstico profundo: vuelca TODOS los movimientos con validación de saldo.
 * Escribe resultados a debug-febrero-output.txt para análisis.
 */

const path = require('path');
const fs = require('fs');
const { SantanderExtractor } = require('../services/bank-extractor/banks/santander');

const PDF = path.join(__dirname, '../../pdfs_muestra/SANTANDER BERSA 223 FEBRERO 2024.pdf');
const OUT = path.join(__dirname, 'debug-febrero-output.txt');

function toFloat(v) {
  if (!v) return 0;
  return parseFloat(String(v).replace(/,/g, '')) || 0;
}

async function main() {
  const lines = [];
  const log = (s) => { lines.push(s); process.stdout.write(s + '\n'); };

  log('Cargando SANTANDER BERSA 223 FEBRERO 2024.pdf...');
  const extractor = new SantanderExtractor(PDF);
  const txs = await extractor.extractTransactions();
  log(`Extraidas ${txs.length} transacciones. OCR: ${extractor.usedOcr}\n`);

  let prevSaldo = 299667.05;   // saldo inicial conocido del estado
  let brokenRows = 0;

  const header = 'IDX | FECHA       | MONTO_R             | MONTO_D             | SALDO_EXT       | SALDO_CALC      | STATUS   | CONCEPTO';
  log(header);
  log('-'.repeat(130));

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    const R = toFloat(tx['MONTO RETIROS']);
    const D = toFloat(tx['MONTO DEPOSITOS']);
    const S = toFloat(tx['SALDO']);

    const calcSaldo = Math.round((prevSaldo - R + D) * 100) / 100;
    const diff = S > 0 ? Math.abs(calcSaldo - S) : 0;
    const status = S === 0 ? 'NO_SALDO  ' : diff < 1 ? 'OK        ' : `ERR ${diff.toFixed(0).padStart(10)}`;

    const row = [
      String(i + 1).padStart(3),
      tx['FECHA'] || '',
      String(tx['MONTO RETIROS'] || '').padStart(19),
      String(tx['MONTO DEPOSITOS'] || '').padStart(19),
      String(S || '').padStart(15),
      String(calcSaldo).padStart(15),
      status,
      (tx['CONCEPTO'] || '').slice(0, 60)
    ].join(' | ');

    log(row);

    if (diff >= 1) brokenRows++;
    if (S > 0) prevSaldo = S;
  }

  const totalR = txs.reduce((s, t) => s + toFloat(t['MONTO RETIROS']), 0);
  const totalD = txs.reduce((s, t) => s + toFloat(t['MONTO DEPOSITOS']), 0);

  log('\n' + '='.repeat(80));
  log(`Total transacciones  : ${txs.length}`);
  log(`Filas con ERR saldo  : ${brokenRows}`);
  log(`Total Retiros        : ${totalR.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
  log(`Total Depositos      : ${totalD.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
  log(`Esperado Retiros     : 52,090,450.88`);
  log(`Esperado Depositos   : 51,985,062.17`);
  log(`Diff Retiros         : ${(totalR - 52090450.88).toFixed(2)}`);
  log(`Diff Depositos       : ${(totalD - 51985062.17).toFixed(2)}`);
  log(`Saldo final calculado: ${prevSaldo.toFixed(2)}  (esperado: 194,278.34)`);

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  log(`\nOutput completo guardado en: ${OUT}`);
}

main().catch(console.error);
