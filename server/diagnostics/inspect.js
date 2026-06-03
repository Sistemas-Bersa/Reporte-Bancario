'use strict';
const path=require('path'), fs=require('fs');
const { SantanderExtractor } = require('../services/bank-extractor/banks');
const PRINTED={dep:44621085.94,ret:44419745.09};
const cache=JSON.parse(fs.readFileSync(path.join(__dirname,'texts-SANTANDER-ABRIL.json'),'utf8'));
const toNum=s=>s?parseFloat(String(s).replace(/,/g,''))||0:0;
const fmt=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2});
(async()=>{
  const e=new SantanderExtractor(cache.name,()=>{},cache.pages); e.usedOcr=true;
  const tx=await e.extractTransactions();
  const dep=tx.filter(t=>toNum(t['MONTO DEPOSITOS'])>0).map(t=>({a:toNum(t['MONTO DEPOSITOS']),c:t['CONCEPTO'],f:t['FECHA']}));
  const ret=tx.filter(t=>toNum(t['MONTO RETIROS'])>0).map(t=>({a:toNum(t['MONTO RETIROS']),c:t['CONCEPTO'],f:t['FECHA']}));
  const sum=a=>a.reduce((x,y)=>x+y.a,0);
  console.log(`Depósitos: ${dep.length} filas, suma ${fmt(sum(dep))} (impreso ${fmt(PRINTED.dep)}, +${fmt(sum(dep)-PRINTED.dep)})`);
  console.log(`Retiros:   ${ret.length} filas, suma ${fmt(sum(ret))} (impreso ${fmt(PRINTED.ret)}, ${fmt(sum(ret)-PRINTED.ret)})`);
  console.log('\nTOP 12 DEPÓSITOS:');
  dep.sort((a,b)=>b.a-a.a).slice(0,12).forEach(d=>console.log(`  ${fmt(d.a).padStart(16)}  ${d.f}  ${(d.c||'').slice(0,55)}`));
  console.log('\nTOP 12 RETIROS:');
  ret.sort((a,b)=>b.a-a.a).slice(0,12).forEach(d=>console.log(`  ${fmt(d.a).padStart(16)}  ${d.f}  ${(d.c||'').slice(0,55)}`));
  // Montos con >7 digitos enteros (sospechosos de digito extra)
  const big=dep.concat(ret).filter(d=>d.a>=10000000);
  console.log(`\nMontos >= 10,000,000 (posible dígito extra): ${big.length}`);
  big.sort((a,b)=>b.a-a.a).forEach(d=>console.log(`  ${fmt(d.a).padStart(16)}  ${d.f}  ${(d.c||'').slice(0,55)}`));
})();
