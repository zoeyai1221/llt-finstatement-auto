const XLSX=require('./vendor/xlsx.full.min.js'); const L=require('./src/core.js'); const path=require('path');
const dir=path.join(__dirname,'..');
const rd=f=>XLSX.utils.sheet_to_json(XLSX.read(require('fs').readFileSync(path.join(dir,f))).Sheets.Sheet1,{header:1,raw:true,defval:null});
const files=["Ladies Let's Talk_Statement of Activity Detail.xlsx","Ladies Let's Talk_Statement of Activity Detail (1).xlsx"].map(f=>{const r=rd(f);console.log(f,L.detectReport(r));return L.parseActivity(r,f)});
files.forEach(f=>console.log(f.period.start.toDateString(),f.period.end.toDateString(),f.exportedAt,f.basis,f.rowCount,JSON.stringify(f.checks),f.warnings));
const m=L.mergeActivity(files); console.log(m.firstMonth,m.lastMonth,m.facts.length,m.notes);
const asOf=new Date(2026,5,10);
const x=L.computeMetrics(m.facts,{asOf,dataEnd:m.dataEnd,cash:69844.82});
console.log(x.lastMonth,x.status,x.warnings,x.notes); for(const n of [3,6,12]){const w=x.windows[n];console.log(n,Math.round(w.burn),Math.round(w.inflow),Math.round(w.net),w.runway.toFixed(1))}
console.log(x.composition);
// runway history: last point's cash must equal the balance (asOf is after the last full month, so the tail is backed out)
const last=x.months[x.months.length-1]; console.log('hist', x.months.filter(s=>s.runway!==null).map(s=>s.month+':'+s.runway.toFixed(1)).join(' '));
const y=L.computeMetrics(m.facts,{asOf:new Date(2026,4,31),dataEnd:m.dataEnd,cash:1000}); const yl=y.months[y.months.length-1];
console.log('month-end cash matches balance:', Math.abs(yl.cashEnd-1000)<1e-6, 'walk-back consistent:', Math.abs(y.months[y.months.length-2].cashEnd-(1000-yl.net))<1e-6);
