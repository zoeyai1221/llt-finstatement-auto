const XLSX=require('./vendor/xlsx.full.min.js'); const L=require('./src/core.js'); const path=require('path');
const dir=path.join(__dirname,'..');
const rd=f=>XLSX.utils.sheet_to_json(XLSX.read(require('fs').readFileSync(path.join(dir,f))).Sheets.Sheet1,{header:1,raw:true,defval:null});
const files=["Ladies Let's Talk_Statement of Activity Detail.xlsx","Ladies Let's Talk_Statement of Activity Detail (1).xlsx"].map(f=>{const r=rd(f);console.log(f,L.detectReport(r));return L.parseActivity(r,f)});
files.forEach(f=>console.log(f.period.start.toDateString(),f.period.end.toDateString(),f.exportedAt,f.basis,f.rowCount,JSON.stringify(f.checks),f.warnings));
const m=L.mergeActivity(files); console.log(m.firstMonth,m.lastMonth,m.facts.length,m.notes);
const asOf=new Date(2026,5,10);
const x=L.computeMetrics(m.facts,{asOf,dataEnd:m.dataEnd,cash:69844.82});
console.log(x.lastMonth,x.status,x.warnings); for(const n of [3,6,12]){const w=x.windows[n];console.log(n,Math.round(w.burn),Math.round(w.inflow),Math.round(w.net),w.runway.toFixed(1))}
console.log(x.composition);
