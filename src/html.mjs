/**
 * A browsable page for your own sessions — written to a local file, opened in
 * your browser, and never uploaded.
 *
 * Self-contained by design: no CDN, no network, no fonts to fetch. The page is
 * one file you can open on a plane, and it carries your raw prompts, so it is
 * treated like the transcript it came from.
 */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function buildHtml(sessions, { days, root, generatedAt = new Date().toISOString(), redacted = false, summary = null }) {
  const payload = JSON.stringify({ sessions, days, root, generatedAt, redacted, summary }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Marmot · sessions</title>
<style>
:root{
  color-scheme: light;
  --bg:#f7f7f5; --surface:#fcfcfb; --surface-2:#f1f0ed; --line:#e2e1dc;
  --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#87857f;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100;
  --danger:#e34948; --accent:#2a78d6; --track:#e8e7e3; --warn:#a06c00;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme: dark){
  :root:where(:not([data-theme="light"])){
    color-scheme: dark;
    --bg:#131312; --surface:#1a1a19; --surface-2:#232322; --line:#333330;
    --ink:#fff; --ink-2:#c3c2b7; --ink-3:#8d8b83;
    --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
    --danger:#e66767; --accent:#3987e5; --track:#2b2b29; --warn:#c98500; --warn:#c98500;
  }
}
:root[data-theme="dark"]{
  color-scheme: dark;
  --bg:#131312; --surface:#1a1a19; --surface-2:#232322; --line:#333330;
  --ink:#fff; --ink-2:#c3c2b7; --ink-3:#8d8b83;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
  --danger:#e66767; --accent:#3987e5; --track:#2b2b29; --warn:#c98500;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1120px;margin:0 auto;padding:28px 22px 80px}
header.top{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px}
h1{font-size:19px;margin:0;letter-spacing:-.01em}
.sub{color:var(--ink-3);font-size:12.5px}
.note{color:var(--ink-3);font-size:12px;margin:10px 0 22px;padding:9px 12px;background:var(--surface-2);border-radius:7px;border:1px solid var(--line)}
button,select,input{font:inherit;color:inherit}
.btn{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12.5px;color:var(--ink-2)}
.btn:hover{border-color:var(--ink-3);color:var(--ink)}
.btn[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 16px}
.filters input[type=search]{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:5px 10px;min-width:210px}

/* --- tables --- */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.045em;color:var(--ink-3);padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;white-space:nowrap;user-select:none}
th:hover{color:var(--ink)}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr{cursor:pointer}
tbody tr:hover{background:var(--surface-2)}
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:9px}

/* --- stat tiles --- */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:9px;margin:16px 0}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:11px 13px}
.kpi .k{font-size:11px;text-transform:uppercase;letter-spacing:.045em;color:var(--ink-3);margin-bottom:5px}
.kpi .v{font-size:21px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .n{font-size:11.5px;color:var(--ink-3);margin-top:2px}

/* --- per-day columns. Deliberately not .stack, which is the 13px token bar. --- */
.byday{display:flex;align-items:flex-end;gap:2px;height:120px;margin:4px 0 0}
.byday .col{flex:1;min-width:3px;display:flex;flex-direction:column-reverse;height:100%;border-radius:2px;overflow:hidden;background:var(--track)}
.byday .col i{display:block;width:100%}
.byday .col:hover{outline:1px solid var(--ink-3)}
.dlegend{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;font-size:11.5px;color:var(--ink-2)}
.dlegend span{display:inline-flex;align-items:center;gap:5px}
.dlegend span i{width:9px;height:9px;border-radius:2px;display:inline-block;flex:0 0 auto}

/* --- nudges --- */
.nudge{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:9px;padding:11px 14px;margin-bottom:8px}
.nudge h3{margin:0 0 4px;font-size:13px;font-weight:600}
.nudge p{margin:0 0 4px;font-size:12.5px;color:var(--ink-2);line-height:1.5}
.nudge .act{color:var(--ink-3);font-size:12px}
.nudge .who{font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;margin-top:5px}
.idle{color:var(--warn);font-weight:600}
.barrow .lbl u.idlebar{background:var(--warn);opacity:.22}

/* --- charts --- */
.panel{background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:15px 16px;margin:14px 0}
.panel h2{font-size:12.5px;margin:0 0 3px;font-weight:600}
.panel .cap{font-size:11.5px;color:var(--ink-3);margin:0 0 12px}
.stack{display:flex;height:13px;border-radius:3px;overflow:hidden;background:var(--track);gap:2px}
.stack i{display:block}
.legend{display:flex;gap:15px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--ink-2)}
.legend span{display:flex;align-items:center;gap:6px}
.sw{width:9px;height:9px;border-radius:2px;flex:none}
.legend b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink)}
.spark{display:flex;align-items:flex-end;gap:1px;height:88px;position:relative}
.spark i{flex:1 1 0;min-width:1px;background:var(--s1);border-radius:2px 2px 0 0;cursor:pointer;transition:opacity .08s}
.spark i:hover{opacity:.62}
.axis{display:flex;justify-content:space-between;font-size:11px;color:var(--ink-3);margin-top:6px}
.barlist{display:flex;flex-direction:column;gap:5px}
.barrow{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;font-size:12.5px}
.barrow .lbl{position:relative;padding:3px 7px;border-radius:4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.barrow .lbl u{position:absolute;inset:0 auto 0 0;background:var(--s1);opacity:.16;border-radius:4px}
.barrow .lbl s{position:relative;text-decoration:none}
.barrow .ct{color:var(--ink-3);font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}

/* --- timeline --- */
.ev{border-left:2px solid var(--line);padding:0 0 0 15px;margin:0 0 3px;position:relative}
.ev.prompt{border-left-color:var(--s1)}
.ev.compact{border-left-color:var(--s4)}
.ev .meta{font-size:11px;color:var(--ink-3);display:flex;gap:9px;flex-wrap:wrap;align-items:center;padding:5px 0}
.ev .who{font-weight:600;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em;font-size:10.5px}
.ev .body{white-space:pre-wrap;word-break:break-word;font-size:13px;background:var(--surface);border:1px solid var(--line);border-radius:7px;padding:9px 12px;margin:0 0 7px;max-height:270px;overflow:auto}
.ev.prompt .body{background:var(--surface-2)}
.tools{display:flex;flex-direction:column;gap:3px;margin:0 0 8px}
.tool{display:flex;gap:8px;align-items:baseline;font-size:12px;font-family:var(--mono);background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:4px 9px}
.tool.err{border-color:var(--danger)}
.tool .tn{font-weight:600;color:var(--ink);flex:none}
.tool .ta{color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.tag{font-size:10px;padding:1px 6px;border-radius:99px;border:1px solid var(--line);color:var(--ink-3);flex:none;font-family:var(--sans)}
.tag.mcp{border-color:var(--s3);color:var(--s3)}
.tag.skill{border-color:var(--s2);color:var(--s2)}
.tag.err{border-color:var(--danger);color:var(--danger)}
.trunc{color:var(--ink-3);font-size:11.5px;font-style:italic;margin-top:5px}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{font-family:var(--mono);font-size:11.5px;background:var(--surface-2);border:1px solid var(--line);border-radius:4px;padding:2px 7px;color:var(--ink-2);white-space:nowrap}
.hide{display:none!important}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--bg);padding:5px 9px;border-radius:5px;font-size:11.5px;z-index:9;opacity:0;transition:opacity .1s;font-variant-numeric:tabular-nums;white-space:nowrap}
.crumb{display:flex;gap:9px;align-items:center;margin-bottom:14px;font-size:12.5px}
.empty{color:var(--ink-3);padding:26px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Marmot</h1>
    <span class="sub" id="scope"></span>
    <span style="flex:1"></span>
    <button class="btn" id="theme">Theme</button>
  </header>
  <div class="note" id="privacy"></div>
  <div id="view"></div>
</div>
<div id="tip"></div>
<script type="application/json" id="data">${payload}</script>
<script>
(function(){
"use strict";
var D = JSON.parse(document.getElementById("data").textContent);
var S = D.sessions;
var view = document.getElementById("view");
var tip = document.getElementById("tip");

var usd = function(n){ return n>=100 ? "$"+Math.round(n).toLocaleString() : "$"+n.toFixed(2); };
var num = function(n){ return Math.round(n).toLocaleString(); };
var tok = function(n){
  var f=function(v,u){ return (v>=100?Math.round(v):v.toFixed(1))+u; };
  return n>=1e9?f(n/1e9,"B"):n>=1e6?f(n/1e6,"M"):n>=1e3?f(n/1e3,"K"):String(n||0); };
var mins = function(n){ return n>=1440?(n/1440).toFixed(1)+"d":n>=60?(n/60).toFixed(1)+"h":Math.round(n)+"m"; };
var pct = function(n){ return n==null?"—":Math.round(n*100)+"%"; };
var esc = function(s){ var d=document.createElement("div"); d.textContent=s==null?"":String(s); return d.innerHTML; };
var clock = function(t){ if(!t) return ""; var d=new Date(t); return d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}); };

document.getElementById("scope").textContent = S.length+" sessions · last "+D.days+" days · "+D.root;
document.getElementById("privacy").textContent = D.redacted
  ? "Generated locally. Prompt and response text was redacted with --no-text; only counts, tool names and inputs are here."
  : "Generated locally and never uploaded. This file contains your raw prompts and responses — treat it like the transcript it came from.";

document.getElementById("theme").onclick = function(){
  var r=document.documentElement, cur=r.getAttribute("data-theme");
  var dark = cur ? cur==="dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  r.setAttribute("data-theme", dark?"light":"dark");
};

function showTip(e, html){ tip.innerHTML=html; tip.style.opacity="1";
  var x=e.clientX+12, y=e.clientY-30;
  if(x+tip.offsetWidth>innerWidth-8) x=e.clientX-tip.offsetWidth-12;
  tip.style.left=x+"px"; tip.style.top=y+"px"; }
function hideTip(){ tip.style.opacity="0"; }

/** Every element carrying a tooltip, wherever it was rendered. */
function bindTips(){
  Array.prototype.forEach.call(view.querySelectorAll("[data-t]"),function(el){
    el.onmousemove=function(e){ showTip(e,el.getAttribute("data-t")); };
    el.onmouseleave=hideTip;
  });
}

function kpi(k,v,n){ return '<div class="kpi"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div>'+(n?'<div class="n">'+esc(n)+'</div>':'')+'</div>'; }

/* Part-to-whole across four token classes: a stacked bar, categorical hues in
   fixed slot order, every value direct-labelled in the legend. */
function tokenStack(t){
  var parts=[["Cache read",t.cacheRead,"--s1"],["Cache write",t.cacheWrite,"--s2"],["Input",t.input,"--s3"],["Output",t.output,"--s4"]];
  var tot=parts.reduce(function(a,p){return a+p[1];},0)||1;
  return '<div class="panel"><h2>Token composition</h2><p class="cap">Where the '+tok(tot)+' tokens sat. Cache reads bill at a tenth of the input rate; cache writes at 1.25× or 2×.</p>'
    +'<div class="stack">'+parts.map(function(p){ return '<i style="width:'+(p[1]/tot*100).toFixed(2)+'%;background:var('+p[2]+')"></i>'; }).join("")+'</div>'
    +'<div class="legend">'+parts.map(function(p){ return '<span><i class="sw" style="background:var('+p[2]+')"></i>'+p[0]+' <b>'+tok(p[1])+'</b> <span style="color:var(--ink-3)">'+(p[1]/tot*100).toFixed(0)+'%</span></span>'; }).join("")+'</div></div>';
}

/* Cost per model turn. Magnitude over an ordered axis -> bars, one hue.
   Bucketed when a session has more turns than the chart has pixels. */
function costTimeline(s){
  var turns=[], i;
  for(i=0;i<s.events.length;i++) if(s.events[i].kind==="assistant") turns.push({i:i,cost:s.events[i].cost||0});
  if(!turns.length) return "";
  var MAX=180, per=Math.ceil(turns.length/MAX), buckets=[];
  for(i=0;i<turns.length;i+=per){
    var g=turns.slice(i,i+per);
    buckets.push({from:i+1,to:i+g.length,cost:g.reduce(function(a,x){return a+x.cost;},0),idx:g[0].i});
  }
  var max=Math.max.apply(null,buckets.map(function(b){return b.cost;}))||1;
  return '<div class="panel"><h2>Cost per model turn</h2><p class="cap">'+num(turns.length)+' turns'
    +(per>1?', grouped '+per+' to a bar':'')+'. Click a bar to jump to it.</p>'
    +'<div class="spark">'+buckets.map(function(b){
        return '<i data-i="'+b.idx+'" data-t="'+esc((per>1?("Turns "+b.from+"–"+b.to):("Turn "+b.from))+" · "+usd(b.cost))+'" style="height:'+Math.max(2,b.cost/max*100).toFixed(1)+'%"></i>';
      }).join("")+'</div>'
    +'<div class="axis"><span>turn 1</span><span>peak '+usd(max)+' per bar</span><span>turn '+turns.length+'</span></div></div>';
}

function barlist(title, cap, counts){
  var rows=Object.keys(counts).map(function(k){return [k,counts[k]];}).sort(function(a,b){return b[1]-a[1];}).slice(0,12);
  if(!rows.length) return '<div class="panel"><h2>'+esc(title)+'</h2><p class="cap">'+esc(cap)+'</p><div class="empty">None.</div></div>';
  var max=rows[0][1];
  return '<div class="panel"><h2>'+esc(title)+'</h2><p class="cap">'+esc(cap)+'</p><div class="barlist">'
    +rows.map(function(r){ return '<div class="barrow"><div class="lbl"><u style="width:'+(r[1]/max*100).toFixed(1)+'%"></u><s>'+esc(r[0])+'</s></div><div class="ct">'+num(r[1])+'</div></div>'; }).join("")
    +'</div></div>';
}

/* A count of 1 on every row means a bar encodes nothing; this is a list. */
function filelist(files){
  if(!files||!files.length) return "";
  var CAP=60, shown=files.slice(0,CAP);
  return '<div class="panel"><h2>Files changed</h2><p class="cap">'+num(files.length)+' path'+(files.length===1?'':'s')+' this session wrote.</p>'
    +'<div class="chips">'+shown.map(function(f){
        var short=f.split("/").slice(-2).join("/");
        return '<code class="chip" title="'+esc(f)+'">'+esc(short)+'</code>';
      }).join("")
    +'</div>'+(files.length>CAP?'<div class="trunc">and '+num(files.length-CAP)+' more</div>':'')+'</div>';
}

/* ---------------- index ---------------- */
var sortKey="cost", sortDir=-1;
/** Your plan's own limits, which on a subscription are the real ceiling. */
function planKpis(){
  var P=D.summary&&D.summary.plan; if(!P||!P.limits) return "";
  var out="";
  for(var i=0;i<P.limits.length;i++){
    var l=P.limits[i];
    if(!l.active&&l.percent===0&&!l.resetsAt) continue;
    var name=l.label.charAt(0).toUpperCase()+l.label.slice(1)+" limit";
    if(l.expired){ out+=kpi(name,"\u2014","that window has since reset"); continue; }
    out+=kpi(name,l.percent+"%",l.resetsAt?"resets "+resetIn(l.resetsAt):"");
  }
  if(P.spend&&P.spend.enabled&&P.spend.limit) out+=kpi("Usage credits",usd(P.spend.used||0)+" of "+usd(P.spend.limit),"real money");
  return out;
}

function resetIn(iso){
  var m=(Date.parse(iso)-Date.now())/60000;
  if(!isFinite(m)) return "";
  return m<=0?"shortly":"in "+mins(m);
}

/**
 * One series over the window, as a stacked column per day. Answers what a total
 * cannot: whether a skill, server or model is a habit or a one-off.
 */
function stackedByDay(title,cap,days,keys,pick,fmt){
  fmt=fmt||num;
  if(!days.length||!keys.length) return "";
  var max=0;
  days.forEach(function(d){ var t=0; keys.forEach(function(k){ t+=pick(d,k)||0; }); if(t>max) max=t; });
  if(!max) return "";
  var pal=["var(--s1)","var(--s2)","var(--s3)","var(--s4)","var(--accent)","var(--warn)"];
  var cols=days.map(function(d){
    var segs="",total=0,rows="";
    keys.forEach(function(k,i){
      var v=pick(d,k)||0; if(!v) return; total+=v;
      segs+='<i style="height:'+(v/max*100)+'%;background:'+pal[i%pal.length]+'"></i>';
      if(keys.length>1) rows+='<div><i style="background:'+pal[i%pal.length]+'"></i>'+esc(k)+' <b>'+fmt(v)+'</b></div>';
    });
    if(!rows) rows='<div class="sub">nothing this day</div>';
    return '<div class="col" data-t="'+esc('<b>'+d.day+'</b> · '+fmt(total)+rows)+'">'+segs+'</div>';
  }).join("");
  var legend=keys.length>1?keys.map(function(k,i){
    return '<span><i style="background:'+pal[i%pal.length]+'"></i>'+esc(k)+'</span>';
  }).join(""):"";
  return '<div class="panel"><h2>'+esc(title)+'</h2><p class="cap">'+esc(cap)+'</p>'
    +'<div class="byday">'+cols+'</div>'
    +'<div class="axis"><span>'+esc(days[0].day)+'</span><span>'+esc(days[days.length-1].day)+'</span></div>'
    +(legend?'<div class="dlegend">'+legend+'</div>':"")+'</div>';
}

/** Per-day totals for skills, MCP servers and models, from the sessions. */
function seriesByDay(){
  var byDay={};
  S.forEach(function(s){
    var d=byDay[s.day]||(byDay[s.day]={day:s.day,cost:0,skills:{},mcp:{},models:{}});
    d.cost+=s.cost||0;
    var k;
    for(k in (s.skillCounts||{})) d.skills[k]=(d.skills[k]||0)+s.skillCounts[k];
    for(k in (s.mcpCounts||{})) d.mcp[k]=(d.mcp[k]||0)+s.mcpCounts[k];
    for(k in (s.modelTokens||{})) d.models[k]=(d.models[k]||0)+((s.modelTokens[k]||{}).total||0);
  });
  return Object.keys(byDay).sort().map(function(k){ return byDay[k]; });
}

/** The names worth a colour: the biggest few, so a legend stays readable. */
function topKeys(days,field,n){
  var totals={};
  days.forEach(function(d){ for(var k in d[field]) totals[k]=(totals[k]||0)+d[field][k]; });
  return Object.keys(totals).sort(function(a,b){ return totals[b]-totals[a]; }).slice(0,n);
}

/** Models, skills, MCP servers and the nudges: the report, on the page. */
function summaryPanels(){
  var Z=D.summary; if(!Z||!Z.totals) return "";
  var M=Z.totals, out="";

  var P=Z.projects||[];
  if(P.length>1){
    var maxCost=P[0].cost||1;
    out+='<div class="panel"><h2>By project</h2><p class="cap">Each working directory is its own setup, with its own MCP servers and skills. Every nudge below is computed across all of them.</p><div class="barlist">'
      +P.map(function(r){
        var w=maxCost?(r.cost/maxCost*100):0;
        var name=r.dir.split("/").slice(-2).join("/");
        return '<div class="barrow"><div class="lbl"><u style="width:'+w.toFixed(1)+'%"></u><s>'+esc(name)+(r.scoped&&r.scoped.length?" · +"+esc(r.scoped.join(", ")):"")+'</s></div>'
          +'<div class="ct">'+usd(r.cost)+" · "+num(r.sessions)+" sess · "+num(r.prompts)+' prompts</div></div>';
      }).join("")+'</div></div>';
  }

  var PL=Z.plan;
  if(PL&&PL.limits&&PL.limits.length){
    var live=PL.limits.filter(function(l){ return !l.expired && (l.active||l.resetsAt); });
    if(live.length){
      out+='<div class="panel"><h2>Plan limits</h2><p class="cap">How much of each window is gone'
        +(PL.plan?" on "+esc(PL.plan):"")+'. This is what actually runs out; the dollars above are a shadow price.</p><div class="barlist">'
        +live.map(function(l){
          var cls=l.percent>=90?"var(--danger)":l.percent>=75?"var(--warn)":"var(--s3)";
          var note=l.resetsAt?"resets "+resetIn(l.resetsAt):"";
          return '<div class="barrow"><div class="lbl"><u style="width:'+l.percent+'%;background:'+cls+';opacity:.3"></u><s>'
            +esc(l.label.charAt(0).toUpperCase()+l.label.slice(1))+'</s></div>'
            +'<div class="ct">'+l.percent+'% <span class="sub">'+esc(note)+'</span></div></div>';
        }).join("")+'</div>'
        +(PL.spend&&PL.spend.enabled&&PL.spend.limit
          ? '<div class="barlist" style="margin-top:8px"><div class="barrow"><div class="lbl"><u style="width:'
            +Math.min(100,((PL.spend.used||0)/PL.spend.limit)*100)+'%"></u><s>Usage credits</s></div>'
            +'<div class="ct">'+usd(PL.spend.used||0)+" of "+usd(PL.spend.limit)+' <span class="sub">real money</span></div></div></div>'
          : "")
        +'</div>';
    }
  }

  var days=seriesByDay();
  out+=stackedByDay("Spend by day","Modelled at published rates, day by day across the window.",days,["spend"],function(d){return d.cost;},usd);
  out+=stackedByDay("Model tokens by day","Which model the window's tokens went to, day by day.",days,topKeys(days,"models",6),function(d,k){return d.models[k];},tok);
  out+=stackedByDay("Skills by day","How often each skill loaded. A habit looks different from a one-off.",days,topKeys(days,"skills",6),function(d,k){return d.skills[k];});
  out+=stackedByDay("MCP calls by day","Calls per server. A server with no bar all window is one you pay for on every request and never use.",days,topKeys(days,"mcp",6),function(d,k){return d.mcp[k];});

  var models=Object.keys(M.models||{}).map(function(m){return [m,M.models[m]];}).sort(function(a,b){return b[1]-a[1];});
  if(models.length){
    out+='<div class="panel"><h2>Where it went</h2><p class="cap">Modelled at published rates. On a subscription plan this is a shadow price, not an invoice line.</p><div class="barlist">'
      +models.map(function(r){
        var w=M.cost?(r[1]/M.cost*100):0;
        var tk=(M.modelTokens||{})[r[0]];
        return '<div class="barrow"><div class="lbl"><u style="width:'+w.toFixed(1)+'%"></u><s>'+esc(r[0])+'</s></div>'
          +'<div class="ct">'+usd(r[1])+' · '+Math.round(w)+'%'+(tk?" · "+tok(tk):"")+'</div></div>';
      }).join("")+'</div></div>';
  }

  if((Z.skills||[]).length){
    var maxSkill=Z.skills[0].onLoad||1;
    out+='<div class="panel"><h2>Skills</h2><p class="cap">What each costs to load, measured from the SKILL.md on disk. Skills that ship inside Claude Code are not on disk, and are not guessed at.</p><div class="barlist">'
      +Z.skills.map(function(r){
        var w=r.onLoad?(r.onLoad/maxSkill*100):0;
        return '<div class="barrow"><div class="lbl"><u style="width:'+w.toFixed(1)+'%"></u><s>'+esc(r.name)+'</s></div>'
          +'<div class="ct">'+num(r.calls)+'× · '+(r.known?"~"+tok(r.onLoad)+" to load":"size not readable")+'</div></div>';
      }).join("")+'</div></div>';
  }

  var names={}, k;
  for(k in (M.mcp||{})) names[k]=1;
  for(k in (Z.mcp||{})) names[k]=1;
  (Z.configured||[]).forEach(function(n){ names[n]=1; });
  var servers=Object.keys(names);
  if(servers.length){
    var rows=servers.map(function(n){ return {name:n, calls:(M.mcp||{})[n]||0, size:(Z.mcp||{})[n]||null}; })
      .sort(function(a,b){ return b.calls-a.calls || ((b.size&&b.size.tokens)||0)-((a.size&&a.size.tokens)||0); });
    var total=0, idle=0;
    rows.forEach(function(r){ if(r.size&&r.size.tokens){ total+=r.size.tokens; if(!r.calls) idle+=r.size.tokens; } });
    out+='<div class="panel"><h2>MCP servers</h2><p class="cap">Tool definitions from every attached server are sent with every request'
      +(total?", "+num(total)+" tokens in total"+(idle?', <span class="idle">'+num(idle)+" of them for servers never called</span>":""):"")
      +'.</p><div class="barlist">'
      +rows.map(function(r){
        var t=(r.size&&r.size.tokens)||0;
        // The bar is the cost it adds to every request, not how often it was
        // called — an idle server is the expensive case, and must look it.
        var w=total&&t?(t/total*100):0;
        var note=r.size?(r.size.error?esc(r.size.error):r.size.count+" tools · ~"+tok(t)):"not measured";
        return '<div class="barrow"><div class="lbl"><u style="width:'+w.toFixed(1)+'%"'+(r.calls?"":' class="idlebar"')+'></u><s'+(r.calls?"":' class="idle"')+'>'+esc(r.name)+'</s></div>'
          +'<div class="ct">'+num(r.calls)+'× · '+note+(r.calls?"":' · <span class="idle">never called</span>')+'</div></div>';
      }).join("")+'</div></div>';
  }

  var errs=M.toolErrorsByName||{}, errNames=Object.keys(errs);
  if(errNames.length){
    var rows=errNames.map(function(n){ return {name:n, errors:errs[n], calls:(M.toolCallsByName||{})[n]||errs[n]}; })
      .sort(function(a,b){ return b.errors-a.errors || (b.errors/b.calls)-(a.errors/a.calls); }).slice(0,10);
    var maxErr=rows[0].errors||1;
    out+='<div class="panel"><h2>Tools failing</h2><p class="cap">Every failure is paid for twice — once to fail, once to retry. A tool failing every time is a wrong path or a missing permission, not bad luck.</p><div class="barlist">'
      +rows.map(function(r){
        var rate=r.errors/r.calls;
        return '<div class="barrow"><div class="lbl"><u style="width:'+(r.errors/maxErr*100).toFixed(1)+'%;background:var(--danger);opacity:.28"></u><s'+(rate>=0.5?' class="idle"':'')+'>'+esc(r.name)+'</s></div>'
          +'<div class="ct">'+num(r.errors)+" of "+num(r.calls)+" · "+pct(rate)+'</div></div>';
      }).join("")+'</div></div>';
  }

  var N=Z.nudges||{};
  var all=(N.windowNudges||[]).map(function(w){ return {label:w.label,detail:w.detail,action:w.action,hits:null}; })
    .concat((N.sessionNudges||[]).map(function(g){ return {label:g.label,detail:null,action:null,hits:g.hits}; }));
  if(all.length){
    out+='<div class="panel"><h2>'+num(all.length)+" thing"+(all.length===1?"":"s")+' worth knowing</h2>'
      +'<p class="cap">Deterministic rules over this window — no model decided any of these. The thresholds are yours, in ~/.claude/marmot.json.</p>'
      +all.map(function(n){
        var body="";
        if(n.detail) body='<p>'+esc(n.detail)+'</p><div class="act">'+esc(n.action||"")+'</div>';
        else if(n.hits&&n.hits.length){
          body=n.hits.slice(0,3).map(function(h){
            var s=h.session||{};
            return '<p>'+esc(h.detail)+'</p><div class="who">'+esc(String(s.id||"").slice(0,8))+" · "+esc(s.day||"")+" · "+esc((s.cwd||"").split("/").slice(-2).join("/"))+'</div>';
          }).join("")
          +(n.hits.length>3?'<div class="who">…and '+(n.hits.length-3)+' more</div>':"")
          +'<div class="act" style="margin-top:6px">'+esc(n.hits[0].action||"")+'</div>';
        }
        return '<div class="nudge"><h3>'+esc(n.label)+(n.hits&&n.hits.length>1?" · "+n.hits.length+" sessions":"")+'</h3>'+body+'</div>';
      }).join("")+'</div>';
  }
  return out;
}

function renderIndex(){
  location.hash="";
  var cols=[["day","Date",0],["title","Session",0],["cost","Cost",1],["typedPrompts","Prompts",1],
            ["assistantTurns","Turns",1],["totalToolCalls","Tools",1],["cacheHitRate","Cache",1],["durationMins","Span",1]];
  var rows=S.slice().sort(function(a,b){
    var x=a[sortKey], y=b[sortKey];
    if(typeof x==="string"||typeof y==="string") return String(x||"").localeCompare(String(y||""))*sortDir;
    return ((x||0)-(y||0))*sortDir;
  });
  var tot=S.reduce(function(a,s){return{cost:a.cost+s.cost,p:a.p+s.typedPrompts,t:a.t+s.assistantTurns,tc:a.tc+s.totalToolCalls};},{cost:0,p:0,t:0,tc:0});
  // Every figure here is computed in Node by the same code as the terminal
  // report and shipped in the payload, so the two cannot disagree.
  var M=(D.summary&&D.summary.totals)||null;
  var pp=M&&M.promptsPerSession;
  view.innerHTML = '<div class="kpis">'
      +kpi("Spend",usd(tot.cost),"published rates")
      +kpi("Sessions",num(S.length))
      +kpi("Prompts",num(tot.p),pp?(pp.mean.toFixed(1)+" mean · "+num(pp.median)+" median · "+num(pp.p99)+" p99"):"you typed")
      +kpi("Model turns",num(tot.t),tot.p?((tot.t/tot.p).toFixed(1)+" per prompt"):"")
      +kpi("Tokens",M?tok(M.tok):"—","input, output and cache")
      +kpi("Cache hit rate",M&&M.cacheHitRate!=null?pct(M.cacheHitRate):"—","higher is cheaper")
      +kpi("Tool calls",num(tot.tc),M&&M.toolCalls?pct(M.toolErrors/M.toolCalls)+" failed":"")
      +(M&&M.baseline!=null?kpi("Baseline context",tok(M.baseline),"before you type"):"")
      +planKpis()
    +'</div>'
    +summaryPanels()
    +'<div class="tablewrap"><table><thead><tr>'
    +cols.map(function(c){ return '<th data-k="'+c[0]+'" class="'+(c[2]?"num":"")+'">'+c[1]+(sortKey===c[0]?(sortDir<0?" ↓":" ↑"):"")+'</th>'; }).join("")
    +'</tr></thead><tbody>'
    +rows.map(function(s){ return '<tr data-id="'+esc(s.id)+'">'
        +'<td>'+esc(s.day)+'</td>'
        +'<td><div>'+esc(s.title||"(untitled)")+'</div><div class="sub">'+esc((s.cwd||"").split("/").slice(-2).join("/"))+(s.gitBranch&&s.gitBranch!=="HEAD"?" · "+esc(s.gitBranch):"")+'</div></td>'
        +'<td class="num">'+usd(s.cost)+'</td><td class="num">'+num(s.typedPrompts)+'</td>'
        +'<td class="num">'+num(s.assistantTurns)+'</td><td class="num">'+num(s.totalToolCalls)+'</td>'
        +'<td class="num">'+pct(s.cacheHitRate)+'</td><td class="num">'+mins(s.durationMins)+'</td></tr>'; }).join("")
    +'</tbody></table></div>';
  Array.prototype.forEach.call(view.querySelectorAll("th"),function(th){
    th.onclick=function(){ var k=th.getAttribute("data-k"); if(k===sortKey) sortDir=-sortDir; else {sortKey=k;sortDir=-1;} renderIndex(); };
  });
  Array.prototype.forEach.call(view.querySelectorAll("tbody tr"),function(tr){
    tr.onclick=function(){ location.hash="s/"+tr.getAttribute("data-id"); };
  });
  bindTips();
}

/* ---------------- detail ---------------- */
var show={prompt:true,assistant:true,tools:true,errOnly:false,q:""};
function renderDetail(s){
  var t=s.tokens;
  view.innerHTML='<div class="crumb"><a href="#" id="back">← All sessions</a><span class="sub">'+esc(s.id)+'</span></div>'
    +'<h1 style="margin:0 0 4px;font-size:17px">'+esc(s.title||"(untitled session)")+'</h1>'
    +'<div class="sub" style="margin-bottom:6px">'+esc(s.cwd||"")+(s.gitBranch?' · '+esc(s.gitBranch):'')+' · '+clock(s.startedAt)+' → '+clock(s.endedAt)+' · '+mins(s.durationMins)+(s.version?' · v'+esc(s.version):'')+'</div>'
    +'<div class="kpis">'
      +kpi("Cost",usd(s.cost),"shadow price")
      +kpi("Prompts",num(s.typedPrompts),"you typed")
      +kpi("Model turns",num(s.assistantTurns),s.sidechainTurns?num(s.sidechainTurns)+" in subagents":"")
      +kpi("Tool calls",num(s.totalToolCalls),s.toolErrors?num(s.toolErrors)+" failed":"none failed")
      +kpi("Cache hit",pct(s.cacheHitRate))
      +kpi("Thinking",tok(t.thinking),"tokens")
      +kpi("Compactions",num(s.compactions),s.compactions?"":"no context reset")
    +'</div>'
    +(s.trimmed
      ? '<div class="panel"><h2>Timeline not included</h2><p class="cap">This session counts towards every figure on the front page. Its turn-by-turn timeline was left out to keep this file small — only the most recent sessions carry one, and all of them together would be three times the size. To read this one: <code>marmot browse --session '+esc(String(s.id).slice(0,8))+'</code></p></div>'
      : "")
    +costTimeline(s)
    +tokenStack(t)
    +'<div class="cols">'
      +barlist("Tools","Every call this session made.",s.toolCounts)
      +barlist("Skills","Invoked by name.",s.skillCounts)
      +barlist("MCP servers","Calls by server.",s.mcpCounts)
    +'</div>'
    +filelist(s.filesTouched)
    +'<div class="panel"><h2>Timeline</h2><p class="cap">Every prompt, model turn and tool call, in order. Tool results are not stored — names, inputs and success are.</p>'
      +'<div class="filters">'
        +'<input type="search" id="q" placeholder="Filter text and tool names…">'
        +'<button class="btn" data-f="prompt" aria-pressed="true">Prompts</button>'
        +'<button class="btn" data-f="assistant" aria-pressed="true">Responses</button>'
        +'<button class="btn" data-f="tools" aria-pressed="true">Tool calls</button>'
        +'<button class="btn" data-f="errOnly" aria-pressed="false">Errors only</button>'
      +'</div><div id="tl"></div></div>';

  document.getElementById("back").onclick=function(e){e.preventDefault();location.hash="";};
  Array.prototype.forEach.call(view.querySelectorAll("[data-f]"),function(b){
    b.onclick=function(){ var f=b.getAttribute("data-f"); show[f]=!show[f]; b.setAttribute("aria-pressed",String(show[f])); renderTimeline(s); };
  });
  document.getElementById("q").oninput=function(e){ show.q=e.target.value.toLowerCase(); renderTimeline(s); };
  bindTips();
  Array.prototype.forEach.call(view.querySelectorAll(".spark i"),function(b){
    b.onclick=function(){ var el=document.getElementById("e"+b.getAttribute("data-i")); if(el) el.scrollIntoView({behavior:"smooth",block:"center"}); };
  });
  renderTimeline(s);
}

function renderTimeline(s){
  var q=show.q, out=[];
  for(var i=0;i<s.events.length;i++){
    var e=s.events[i];
    if(e.kind==="compact"){ out.push('<div class="ev compact" id="e'+i+'"><div class="meta"><span class="who">context reset</span><span>'+clock(e.at)+'</span></div></div>'); continue; }
    if(e.kind==="prompt"){
      if(!show.prompt||show.errOnly) continue;
      if(q && e.text.toLowerCase().indexOf(q)<0) continue;
      out.push('<div class="ev prompt" id="e'+i+'"><div class="meta"><span class="who">you</span><span>'+clock(e.at)+'</span></div>'
        +(e.text?'<div class="body">'+esc(e.text)+'</div>':'')
        +(e.truncated?'<div class="trunc">'+num(e.truncated)+' more characters not stored</div>':'')+'</div>');
      continue;
    }
    var tools=e.tools||[];
    if(show.errOnly) tools=tools.filter(function(t){return t.isError;});
    if(q) tools=tools.filter(function(t){return (t.name+" "+t.text).toLowerCase().indexOf(q)>=0;});
    var bodyHit = q ? e.text.toLowerCase().indexOf(q)>=0 : true;
    if(show.errOnly && !tools.length) continue;
    if(q && !tools.length && !bodyHit) continue;
    if(!show.assistant && !show.tools) continue;
    var meta='<div class="meta"><span class="who">claude</span><span>'+clock(e.at)+'</span>'
      +(e.model?'<span>'+esc(e.model)+'</span>':'')
      +(e.cost?'<span>'+usd(e.cost)+'</span>':'')
      +(e.tok?'<span>'+tok(e.tok.in+e.tok.cr+e.tok.cw)+' in · '+tok(e.tok.out)+' out</span>':'')
      +(e.thinking?'<span>'+tok(e.thinking)+' thinking</span>':'')
      +(e.sidechain?'<span class="tag">subagent</span>':'')+'</div>';
    var body = (show.assistant && e.text && bodyHit) ? '<div class="body">'+esc(e.text)+'</div>'+(e.truncated?'<div class="trunc">'+num(e.truncated)+' more characters not stored</div>':'') : '';
    var tl = (show.tools && tools.length) ? '<div class="tools">'+tools.map(function(t){
        return '<div class="tool'+(t.isError?' err':'')+'"><span class="tn">'+esc(t.name)+'</span>'
          +(t.skill?'<span class="tag skill">skill</span>':'')
          +(t.server?'<span class="tag mcp">'+esc(t.server)+'</span>':'')
          +(t.isError?'<span class="tag err">error</span>':'')
          +'<span class="ta" title="'+esc(t.text)+'">'+esc(t.text)+(t.truncated?' …':'')+'</span></div>';
      }).join("")+'</div>' : '';
    if(!body && !tl) continue;
    out.push('<div class="ev" id="e'+i+'">'+meta+body+tl+'</div>');
  }
  document.getElementById("tl").innerHTML = out.length?out.join(""):'<div class="empty">Nothing matches those filters.</div>';
}

function route(){
  var m=/^#s\\/(.+)$/.exec(location.hash);
  if(m){ var s=S.filter(function(x){return x.id===m[1];})[0]; if(s){ renderDetail(s); scrollTo(0,0); return; } }
  renderIndex();
}
addEventListener("hashchange",route);
route();
})();
</script>
</body>
</html>`;
}
