const fs=require('fs');
const html=fs.readFileSync('/home/claude/flat-radar/index.html','utf8');
const logic=html.split('/*LOGIC-START*/')[1].split('/*LOGIC-END*/')[0];
const samples=html.match(/const SAMPLES=(\[[\s\S]*?\n\]);/)[1];
eval(logic+';globalThis.L={extract,processItems,moneyMentions};globalThis.SAMPLES='+samples);
const settings={keywords:'green glen\ngreenglen',keywordFilter:true,groups:'Bellandur Flats & Flatmates (sample) | https://facebook.com/groups/111\nBangalore Rentals HSR Bellandur (sample)'};
for(const s of SAMPLES){const e=L.extract(s.text);console.log(JSON.stringify({rent:e.rent,dep:e.deposit,dm:e.depositMonths,mt:e.maintenance,bhk:e.bhk,type:e.type,kind:e.kind,brok:e.brokerage,furn:e.furnishing,g:e.gender,av:e.availableFrom,ph:e.phones}));}
const r=L.processItems(SAMPLES,'phone',[],settings);
console.log(r.report);
console.log(r.changed.map(l=>[l.rent,l.bhk,l.seenCount,l.groups.length,l.kind,l.outsideWatched]));
// second import of same -> all dupes? (no urls => same text hash => merged as repost). with urls:
const withUrl=SAMPLES.map((s,i)=>({...s,url:'https://www.facebook.com/groups/1/posts/'+i+'/?ref=x'}));
const a=L.processItems(withUrl,'scraper',[],settings); const b=L.processItems(withUrl,'scraper',a.changed,settings);
console.log('reimport',b.report.dupes,b.report.newListings,b.report.merged);
for(const t of ['Rent: 18,500/- per month, 2 months deposit','₹25k rent, maintenance 2000, deposit 1L','Flat available for 2026 Jan, pin 560103, 1200 sqft, rent 40000','2.5 BHK at Green Glen, no broker, 45k']) console.log(t,'=>',JSON.stringify((({rent,deposit,depositMonths,maintenance,bhk,brokerage})=>({rent,deposit,depositMonths,maintenance,bhk,brokerage}))(L.extract(t))));
const items=withUrl; let work=a.changed;
for(const it of items){ const r=L.processItems([it],'scraper',work,settings).report; if(r.merged) console.log('MERGED on reimport:',it.text.slice(0,50), it.url); }
