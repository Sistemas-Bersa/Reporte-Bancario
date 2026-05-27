'use strict';
/**
 * Diagnóstico rápido solo para SANTANDER BERSA 223 FEBRERO 2024.pdf
 * Muestra totales antes y después de la corrección SALDO.
 */

const path = require('path');
const { SantanderExtractor } = require('../services/bank-extractor/banks/santander');

const PDF = path.join(__dirname, '../../pdfs_muestra/SANTANDER BERSA 223 FEBRERO 2024.pdf');

function sum(txs, col) {
  return txs.reduce((s, t) => {
    const v = parseFloat(String(t[col] || '0').replace(/,/g, '')) || 0;
    return s + v;
  }, 0);
}

async function main() {
  console.log('Procesando SANTANDER BERSA 223 FEBRERO 2024.pdf...\n');

  const extractor = new SantanderExtractor(PDF);
  const txs = await extractor.extractTransactions();

  console.log(`\nTransacciones : ${txs.length}`);
  console.log(`Total Retiros : ${sum(txs, 'MONTO RETIROS').toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`Total Depósitos: ${sum(txs, 'MONTO DEPOSITOS').toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`OCR usado     : ${extractor.usedOcr}`);

  console.log('\n--- TOTALES ESPERADOS (del PDF) ---');
  console.log('Total Retiros : 52,090,450.88');
  console.log('Total Depósitos: 51,985,062.17');

  const totalR = sum(txs, 'MONTO RETIROS');
  const totalD = sum(txs, 'MONTO DEPOSITOS');
  const errR = totalR - 52090450.88;
  const errD = totalD - 51985062.17;
  console.log(`\nDiferencia Retiros  : ${errR >= 0 ? '+' : ''}${errR.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`Diferencia Depósitos: ${errD >= 0 ? '+' : ''}${errD.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  // Verificación del balance
  const openSaldo = 299667.05;
  const closeSaldo = sum(txs, 'MONTO DEPOSITOS') - sum(txs, 'MONTO RETIROS') + openSaldo;
  console.log(`\nBalance check: saldo inicial 299,667.05 + neto = ${closeSaldo.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (esperado: 194,278.34)`);

  // Últimas 5
  console.log('\n--- Últimas 5 transacciones ---');
  txs.slice(-5).forEach((t, i) => {
    console.log(`  [${txs.length-4+i}] ${t['FECHA']}  R:${String(t['MONTO RETIROS']).padStart(14)}  D:${String(t['MONTO DEPOSITOS']).padStart(14)}  S:${t['SALDO']}`);
  });
}

main().catch(console.error);
