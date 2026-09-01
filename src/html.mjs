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

export function buildHtml(sessions, { days, root, generatedAt = new Date().toISOString(), redacted = false }) {
  const payload = JSON.stringify({ sessions, days, root, generatedAt, redacted }).replace(/</g, "\\u003c");
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
  --danger:#e34948; --accent:#2a78d6; --track:#e8e7e3;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme: dark){
  :root:where(:not([data-theme="light"])){
    color-scheme: dark;
    --bg:#131312; --surface:#1a1a19; --surface-2:#232322; --line:#333330;
    --ink:#fff; --ink-2:#c3c2b7; --ink-3:#8d8b83;
    --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
    --danger:#e66767; --accent:#3987e5; --track:#2b2b29;
  }
}
:root[data-theme="dark"]{
  color-scheme: dark;
  --bg:#131312; --surface:#1a1a19; --surface-2:#232322; --line:#333330;
  --ink:#fff; --ink-2:#c3c2b7; --ink-3:#8d8b83;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
  --danger:#e66767; --accent:#3987e5; --track:#2b2b29;
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
  view.innerHTML = '<div class="kpis">'
      +kpi("Spend",usd(tot.cost),"published rates")
      +kpi("Sessions",num(S.length))
      +kpi("Prompts",num(tot.p),"you typed")
      +kpi("Model turns",num(tot.t))
      +kpi("Tool calls",num(tot.tc))
    +'</div>'
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
  Array.prototype.forEach.call(view.querySelectorAll(".spark i"),function(b){
    b.onmousemove=function(e){ showTip(e,b.getAttribute("data-t")); };
    b.onmouseleave=hideTip;
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
