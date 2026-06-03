'use strict';
// Laboratorio offline: carga el texto OCR cacheado y prueba estrategias de
// corrección al instante (sin re-OCR), comparando contra el TOTAL impreso.
// Uso: node diagnostics/lab.js
const path = require('path');
const fs   = require('fs');
const { SantanderExtractor } = require('../services/bank-extractor/banks');

const PRINTED = { dep: 44621085.94, ret: 44419745.09 };
const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'texts-SANTANDER-ABRIL.json'), 'utf8'));

function toNum(s){ if(!s) return 0; return parseFloat(String(s).replace(/,/g,''))||0; }
function fmt(n){ return Number(n).toLocaleString('en-US',{minimumFractionDigits:2}); }

function totals(tx){
  let dep=0, ret=0;
  for(const t of tx){ dep+=toNum(t['MONTO DEPOSITOS']); ret+=toNum(t['MONTO RETIROS']); }
  return { dep, ret };
}
function report(label, tx){
  const t = totals(tx);
  const dp = (t.dep - PRINTED.dep)/PRINTED.dep*100;
  const rp = (t.ret - PRINTED.ret)/PRINTED.ret*100;
  console.log(`\n[${label}]  ${tx.length} tx`);
  console.log(`  Dep ${fmt(t.dep)}  (${dp>=0?'+':''}${dp.toFixed(2)}%)`);
  console.log(`  Ret ${fmt(t.ret)}  (${rp>=0?'+':''}${rp.toFixed(2)}%)`);
}

// Reparsea desde el texto cacheado. classify: función opcional que recibe el
// array final y lo transforma (para probar estrategias de corrección).
async function run(label, classify){
  const e = new SantanderExtractor(cache.name, ()=>{}, cache.pages);
  e.usedOcr = true;
  // Neutralizar la corrección interna para aislar estrategias si se pide
  if (classify === 'raw') { e._classifyBySaldo = a=>a; e._correctOcrAmounts = a=>a; }
  let tx = await e.extractTransactions();
  if (typeof classify === 'function') tx = classify(tx);
  report(label, tx);
  return tx;
}

(async()=>{
  console.log(`Impreso → Dep ${fmt(PRINTED.dep)} | Ret ${fmt(PRINTED.ret)}`);

  // 1) Estado actual (con _classifyBySaldo + _correctOcrAmounts)
  await run('ACTUAL (seguro)');

  // 2) Sin ninguna corrección (parser crudo)
  await run('CRUDO (sin saldo-fix)', 'raw');

  // 3) Corrección agresiva: en filas inconsistentes (|captured-delta|>tol),
  //    usar el delta del saldo como monto (capeado para no inflar absurdo).
  await run('AGRESIVO (delta en inconsistentes)', (tx)=>{
    let prev=null;
    for(const t of tx){
      const cur=toNum(t['SALDO']); const has=!!t['SALDO']&&cur>0;
      if(prev!==null&&has){
        const delta=cur-prev;
        const M=toNum(t['MONTO DEPOSITOS'])||toNum(t['MONTO RETIROS']);
        const tol=Math.max(1,Math.abs(delta)*0.02);
        if(Math.abs(M-Math.abs(delta))>tol){
          // capear: no aplicar si delta > 20x el monto (saldo claramente roto)
          if(!(M>0 && Math.abs(delta) > M*20)){
            const amt=Math.abs(delta);
            if(delta>0){ t['MONTO DEPOSITOS']=fmt(amt); t['MONTO RETIROS']=''; }
            else       { t['MONTO RETIROS']=fmt(amt);  t['MONTO DEPOSITOS']=''; }
          }
        }
      }
      if(has) prev=cur;
    }
    return tx;
  });

  // 4) Saldo como verdad absoluta: TODO monto = delta del saldo
  await run('SALDO-TOTAL (todo = delta)', (tx)=>{
    let prev=null;
    for(const t of tx){
      const cur=toNum(t['SALDO']); const has=!!t['SALDO']&&cur>0;
      if(prev!==null&&has){
        const delta=cur-prev; const amt=Math.abs(delta);
        if(amt>=0.01){
          if(delta>0){ t['MONTO DEPOSITOS']=fmt(amt); t['MONTO RETIROS']=''; }
          else       { t['MONTO RETIROS']=fmt(amt);  t['MONTO DEPOSITOS']=''; }
        }
      }
      if(has) prev=cur;
    }
    return tx;
  });
})();
