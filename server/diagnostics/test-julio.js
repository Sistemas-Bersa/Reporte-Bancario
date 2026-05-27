'use strict';
const { extractTransactions } = require('../services/bank-extractor');
const PDF = 'C:\\Users\\programador01\\Desktop\\Resp_AnalistaSAP\\Reporte_Bancario-PDF-Excel\\pdfs_muestra\\BERSA SANTADER JULIO 223.pdf';

extractTransactions(PDF).then(t => {
  const r = t.reduce((s, x) => s + (parseFloat((x['MONTO RETIROS'] || '0').replace(/,/g, '')) || 0), 0);
  const d = t.reduce((s, x) => s + (parseFloat((x['MONTO DEPOSITOS'] || '0').replace(/,/g, '')) || 0), 0);
  console.log(`JULIO: banco=SANTANDER count=${t.length} R=${r.toFixed(2)} D=${d.toFixed(2)}`);
}).catch(e => console.log('ERR:', e.message));
