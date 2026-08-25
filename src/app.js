/* ============================================================
   Realistic dictation simulation.

   A session clock runs in seconds. The radiologist dictates
   continuously; the LLM corrector is triggered when they:
     • say "punto"  (Spanish full stop)
     • say "punto y aparte" / hit a new line
     • go silent for a while (a long pause)

   On each trigger we timestamp it (e.g. 15s), the correction
   runs over the FULL context so far, and the result lands after
   a fixed ~6s latency (e.g. ends 21s). Text keeps streaming in
   during that window, exactly like real dictation.

   Each segment below is one spoken utterance ending in a trigger.
   `secs` = how long the utterance takes to dictate.
   `trigger` = what fired the corrector at the end of it.
   ============================================================ */
const LATENCY = 6;        // seconds between trigger and correction landing
const CLOCK_MS = 240;     // wall-clock ms per simulated second (demo speed)

const SEGMENTS = [
  {
    text: "TÉCNICA punto y aparte Proyecciones posteroanterior y lateral de tórax obtenidas con tecnica digital",
    secs: 7, trigger: "punto",
    fixes: [
      {type:"typo", find:"tecnica digital", old:"tecnica", nw:"técnica", msg:"Missing accent — “técnica”."}
    ]
  },
  {
    text: " punto y aparte HALLAZGOS Los campos pulmonares se encuentran bien espandidos punto Se identifica una lesion tumoral de 5 × 5 × 5 cm",
    secs: 9, trigger: "punto",
    fixes: [
      {type:"typo", find:"espandidos", old:"espandidos", nw:"expandidos", msg:"Spelling — “expandidos”."},
      {type:"typo", find:"lesion tumoral", old:"lesion", nw:"lesión", msg:"Missing accent — “lesión”."}
    ]
  },
  {
    text: " punto No se observa evidencia de otras consolidaciones, nodulos o masas punto El indice cardiotoracico se encuentra dentro de limites normales",
    secs: 10, trigger: "silence",
    fixes: [
      {type:"typo", find:"nodulos o masas", old:"nodulos", nw:"nódulos", msg:"Missing accent — “nódulos”."},
      {type:"style", find:"El indice cardiotoracico", old:"El indice cardiotoracico", nw:"El índice cardiotorácico", msg:"Accents — “índice cardiotorácico”."},
      {type:"grammar", find:"dentro de limites normales", old:"dentro de limites", nw:"dentro de límites", msg:"Missing accent — “límites”."}
    ]
  },
  {
    text: " punto y aparte Las estructuras oseas visualizadas no muestra alteraciones focales",
    secs: 6, trigger: "newline",
    fixes: [
      {type:"typo", find:"estructuras oseas", old:"oseas", nw:"óseas", msg:"Missing accent — “óseas”."},
      {type:"grammar", find:"visualizadas no muestra", old:"no muestra", nw:"no muestran", msg:"Agreement — plural subject needs “muestran”."}
    ]
  },
  {
    text: " punto La trama broncovascular es de aspecto conservado punto No se identifica derrame plural ni neumotorax",
    secs: 8, trigger: "punto",
    fixes: [
      {type:"typo", find:"derrame plural", old:"plural", nw:"pleural", msg:"Spelling — “derrame pleural”, not “plural”."},
      {type:"typo", find:"ni neumotorax", old:"neumotorax", nw:"neumotórax", msg:"Missing accent — “neumotórax”."}
    ]
  },
  {
    text: " punto y aparte IMPRESION Lesion tumoral de 5 cm en campo pulmonar derecho, a correlacionar con antecedentes clinicos del paciente",
    secs: 9, trigger: "silence",
    fixes: [
      {type:"style", find:"IMPRESION", old:"IMPRESION", nw:"IMPRESIÓN", msg:"Missing accent — heading “IMPRESIÓN”."},
      {type:"typo", find:"Lesion tumoral", old:"Lesion", nw:"Lesión", msg:"Missing accent — “Lesión”."},
      {type:"style", find:"antecedentes clinicos", old:"clinicos", nw:"clínicos", msg:"Missing accent — “clínicos”."}
    ]
  }
];
SEGMENTS.forEach(b => b.fixes = b.fixes.filter(f => f.old !== f.nw));

const TRIGGER_LABEL = {
  punto:   "said “punto”",
  newline: "said “punto y aparte” → new line",
  silence: "6 s silence detected"
};

let suggestions = [];  // {id, type, old, nw, msg, marked, ts}
let seq = 0;
let activeId = null;

const editor$ = () => tinymce.get('ed');
const $ = id => document.getElementById(id);

tinymce.init({
  selector:'#ed',
  height:520,
  menubar:false,
  branding:false,
  statusbar:false,
  skin:'oxide-dark',
  content_css:'dark',
  toolbar:'undo redo | bold italic strikethrough | align | bullist numlist | outdent indent',
  content_style:`
    body{background:#151a21;color:#e7ecf2;font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.9;padding:20px 24px;}

    /* the mark carries BOTH old + new; CSS decides what shows */
    .sugg{cursor:pointer;border-radius:2px;transition:background .15s;}
    .sugg:hover{background:rgba(255,255,255,.06);}
    .sugg .s-old, .sugg .s-new{text-decoration:none;}

    /* -------- PANEL MODE (default): underline the old text, hide the new -------- */
    body:not(.inline) .sugg .s-new{display:none;}
    body:not(.inline) .sugg .s-old{border-bottom:2px solid;padding-bottom:1px;}
    body:not(.inline) .sugg.typo    .s-old{border-color:#ff5a52;}
    body:not(.inline) .sugg.grammar .s-old{border-color:#4a9eff;}
    body:not(.inline) .sugg.style   .s-old{border-color:#b07cff;border-bottom-style:dotted;}

    /* -------- INLINE MODE: track-changes, old struck through + new inserted -------- */
    body.inline .sugg{padding:0 2px;}
    body.inline .sugg .s-old{
      text-decoration:line-through;opacity:.6;margin-right:3px;
    }
    body.inline .sugg.typo    .s-old{text-decoration-color:#ff5a52;color:#ff8a84;}
    body.inline .sugg.grammar .s-old{text-decoration-color:#4a9eff;color:#8cc0ff;}
    body.inline .sugg.style   .s-old{text-decoration-color:#b07cff;color:#cbaaff;}
    body.inline .sugg .s-new{font-weight:600;}
    body.inline .sugg.typo    .s-new{color:#7fe0ad;}
    body.inline .sugg.grammar .s-new{color:#7fe0ad;}
    body.inline .sugg.style   .s-new{color:#7fe0ad;}

    .sugg.flash{background:rgba(232,184,75,.28)!important;}

    /* inline timing annotations (like the screenshot) */
    .tstamp{
      font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:11px;
      padding:1px 7px;border-radius:10px;margin:0 3px;white-space:nowrap;
      vertical-align:middle;letter-spacing:.01em;
    }
    .tstamp.pending{
      color:#9cc6ff;background:rgba(74,158,255,.14);border:1px solid rgba(74,158,255,.35);
    }
    .tstamp.pending::before{content:"⋯ ";}
    .tstamp.done{
      color:#7fe0ad;background:rgba(51,196,129,.12);border:1px solid rgba(51,196,129,.3);
    }
    .tstamp.done::before{content:"✓ ";}
  `,
  setup(ed){
    ed.on('init',()=>{ setupIframeEvents(ed); applyDispMode(); });
    ed.on('click',()=>{ /* handled via delegated listener below */ });
  }
});

/* ---- display mode ---- */
const dict = $('dictation');
let dispMode = 'panel';   // 'panel' = right-side list + underlines | 'inline' = track-changes in text

$('modeToggle').addEventListener('click', e=>{
  const b = e.target.closest('.mode-opt'); if(!b) return;
  dispMode = b.dataset.mode;
  [...$('modeToggle').children].forEach(c=>c.classList.toggle('active', c===b));
  applyDispMode();
});

function applyDispMode(){
  const ed = editor$();
  if(ed && ed.getBody()) ed.getBody().classList.toggle('inline', dispMode==='inline');
  document.body.classList.toggle('inline-mode', dispMode==='inline');
  hidePopover();
  renderList();
}

dict.addEventListener('click',()=>{
  if(running) return;
  if(segIdx >= SEGMENTS.length){ flash("Dictation complete."); return; }
  startSession();
});

/* ---------- session clock + continuous dictation ---------- */
let running=false, clock=0, clockTimer=null, segIdx=0, pendingCorrections=0;

function startSession(){
  running=true;
  dict.classList.add('live');
  $('dictLabel').textContent='Recording';
  clockTimer = setInterval(()=>{ clock++; paintClock(); }, CLOCK_MS);
  dictateSegment();
}

function paintClock(){
  $('clock').textContent = clock + 's';
}

/* Dictate one utterance, word by word, over `secs` seconds, then fire its trigger. */
function dictateSegment(){
  const seg = SEGMENTS[segIdx];
  const words = seg.text.trim().split(/\s+/);
  const perWord = Math.max(60, (seg.secs*CLOCK_MS)/words.length);
  let i=0;

  $('dictSub').textContent = `Dictating · segment ${segIdx+1} of ${SEGMENTS.length}`;

  (function push(){
    if(!running) return;
    if(i>=words.length){ fireTrigger(seg); return; }
    appendWord(words[i]);
    updateCtx();
    i++;
    setTimeout(push, perWord);
  })();
}

/* A trigger fires at the end of a segment: timestamp it, drop a pending
   marker, and schedule the correction to land LATENCY seconds later. */
function fireTrigger(seg){
  const tStart = clock;
  const tEnd = clock + LATENCY;
  const markerId = 'mk'+(seq++);

  // visible cue on the mic
  dict.classList.add('trigger');
  $('dictLabel').textContent = 'Trigger';
  $('dictSub').textContent = `${TRIGGER_LABEL[seg.trigger]} → correcting…`;
  setTimeout(()=>dict.classList.remove('trigger'), 600);

  // drop the "running" timestamp marker inline, like the screenshot
  appendMarker(markerId, `${tStart}s → LLM correction…`, 'pending');
  pendingCorrections++;
  paintPending();

  // move to next segment immediately — dictation continues during the 6s wait
  segIdx++;
  if(segIdx < SEGMENTS.length){
    setTimeout(dictateSegment, 400);
  }

  // correction lands after the latency window, timed on the clock
  const landAt = tEnd;
  const waitFor = ()=>{
    if(!running) return;
    if(clock >= landAt){ landCorrection(seg, markerId, tStart, clock); }
    else setTimeout(waitFor, CLOCK_MS/2);
  };
  waitFor();
}

/* Correction result arrives: swap the pending marker for a completed one
   and apply the fixes across the full context. */
function landCorrection(seg, markerId, tStart, tNow){
  const ed = editor$();
  const marker = ed.getDoc().querySelector(`.tstamp[data-mk="${markerId}"]`);
  if(marker){
    marker.classList.remove('pending');
    marker.classList.add('done');
    marker.textContent = `${tStart}s → correction · ends ${tNow}s`;
  }
  applyFixes(seg, tStart, tNow);
  pendingCorrections = Math.max(0, pendingCorrections-1);
  paintPending();

  // session finished?
  if(segIdx>=SEGMENTS.length && pendingCorrections===0){
    endSession();
  }
}

function endSession(){
  running=false;
  clearInterval(clockTimer);
  dict.classList.remove('live');
  $('dictLabel').textContent='Dictate';
  $('dictSub').textContent = `Complete · ${clock}s of dictation`;
}

/* ---------- DOM helpers (write into the iframe) ---------- */
function appendWord(w){
  const ed = editor$();
  ed.getBody().appendChild(ed.getDoc().createTextNode(w+' '));
  caretToEnd(ed);
}
function appendMarker(id, label, cls){
  const ed = editor$();
  const span = ed.getDoc().createElement('span');
  span.className = 'tstamp '+cls;
  span.dataset.mk = id;
  span.contentEditable = 'false';
  span.textContent = label;
  ed.getBody().appendChild(span);
  ed.getBody().appendChild(ed.getDoc().createTextNode(' '));
  caretToEnd(ed);
}
function caretToEnd(ed){
  try{ ed.selection.select(ed.getBody(),true); ed.selection.collapse(false); }catch(e){}
}

/* ---- apply the corrector's fixes across the whole document ---- */
function applyFixes(seg, tStart, tNow){
  const ed = editor$();
  const body = ed.getBody();
  let html = body.innerHTML;

  let added = 0;
  seg.fixes.forEach(fx=>{
    const id = 'sg'+(seq++);
    const safeOld = escapeReg(fx.old);
    // match the old token, but never inside an existing tag or an existing .sugg
    const re = new RegExp('(?![^<]*>)'+safeOld);
    if(re.test(html)){
      html = html.replace(re,
        `<span class="sugg ${fx.type}" data-id="${id}" contenteditable="false">`+
        `<del class="s-old">${fx.old}</del>`+
        `<ins class="s-new">${fx.nw}</ins>`+
        `</span>`);
      suggestions.push({id, type:fx.type, old:fx.old, nw:fx.nw, msg:fx.msg,
                        marked:true, ts:`${tStart}s→${tNow}s`, trig:seg.trigger});
      added++;
    }
  });
  body.innerHTML = html;
  updateCtx();
  renderList();
  if(added) flash(`${added} correction${added>1?'s':''} landed · ${TRIGGER_LABEL[seg.trigger]}`);
}

function paintPending(){
  const el = $('pending');
  if(pendingCorrections>0){ el.style.display='flex'; $('pendingN').textContent=pendingCorrections; }
  else el.style.display='none';
}

/* ---- iframe click / contextmenu delegation ---- */
function setupIframeEvents(ed){
  const doc = ed.getDoc();
  doc.addEventListener('click', e=>{
    const t = e.target.closest('.sugg');
    if(t){ e.preventDefault(); openPopover(t.dataset.id, t); }
    else hidePopover();
  });
  doc.addEventListener('contextmenu', e=>{
    const t = e.target.closest('.sugg');
    if(t){ e.preventDefault(); openPopover(t.dataset.id, t); }
  });
}

/* ---- popover anchored to the span ---- */
function openPopover(id, el){
  const s = suggestions.find(x=>x.id===id);
  if(!s) return;
  activeId = id;
  const pop = $('popover');
  const iframe = document.querySelector('.tox-edit-area__iframe');
  const ir = iframe.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const top = ir.top + er.bottom + 6;
  let left = ir.left + er.left;
  left = Math.min(left, window.innerWidth - 262);

  pop.innerHTML = `
    <div class="pop-top">
      <span class="tag ${s.type}">${s.type}</span>
      <span class="card-time">${s.msg}</span>
    </div>
    <div class="change"><span class="old">${s.old}</span><span class="arrow">→</span><span class="new">${s.nw}</span></div>
    <div class="card-actions">
      <button class="btn accept" onclick="accept('${s.id}')">Accept</button>
      <button class="btn" onclick="ignore('${s.id}')">Ignore</button>
    </div>
    <div class="pop-secondary">
      <button class="btn dict" onclick="addToDict('${s.id}')">＋ Add “${s.old}” to dictionary</button>
    </div>`;
  pop.style.display='block';
  pop.style.top = top+'px';
  pop.style.left = left+'px';
  renderList();
}
function hidePopover(){ $('popover').style.display='none'; activeId=null; renderList(); }

/* ---- actions ---- */
window.accept = function(id){
  const ed=editor$(); const s=suggestions.find(x=>x.id===id); if(!s) return;
  const span = ed.getDoc().querySelector(`.sugg[data-id="${id}"]`);
  if(span){ span.replaceWith(ed.getDoc().createTextNode(s.nw)); }
  remove(id, `Accepted → “${s.nw}”`);
};
window.ignore = function(id){
  const ed=editor$(); const s=suggestions.find(x=>x.id===id); if(!s) return;
  const span = ed.getDoc().querySelector(`.sugg[data-id="${id}"]`);
  if(span){ span.replaceWith(ed.getDoc().createTextNode(s.old)); }
  remove(id, `Ignored`);
};
window.addToDict = function(id){
  const ed=editor$(); const s=suggestions.find(x=>x.id===id); if(!s) return;
  const span = ed.getDoc().querySelector(`.sugg[data-id="${id}"]`);
  if(span){ span.replaceWith(ed.getDoc().createTextNode(s.old)); }
  // also clear any other open suggestion with the same token
  suggestions.filter(x=>x.old===s.old).forEach(x=>{
    const sp = ed.getDoc().querySelector(`.sugg[data-id="${x.id}"]`);
    if(sp) sp.replaceWith(ed.getDoc().createTextNode(x.old));
  });
  suggestions = suggestions.filter(x=>x.old!==s.old);
  hidePopover(); renderList();
  flash(`“${s.old}” added to dictionary — won't flag again`);
};
function remove(id,msg){
  suggestions = suggestions.filter(x=>x.id!==id);
  hidePopover(); renderList(); flash(msg); updateCtx();
}

/* ---- review panel ---- */
function renderList(){
  const list=$('list');
  const open = suggestions.length;
  $('count').textContent = open + ' open';
  if(!open){ list.innerHTML='<div class="empty" id="empty">All clear.<br>Continue dictation to generate the next correction batch.</div>'; return; }
  list.innerHTML = suggestions.map(s=>`
    <div class="card ${s.id===activeId?'active':''}" onclick="focusSugg('${s.id}')">
      <div class="card-top">
        <span class="tag ${s.type}">${s.type}</span>
        <span class="card-time">${s.ts}</span>
      </div>
      <div class="change"><span class="old">${s.old}</span><span class="arrow">→</span><span class="new">${s.nw}</span></div>
      <div class="card-actions">
        <button class="btn accept" onclick="event.stopPropagation();accept('${s.id}')">Accept</button>
        <button class="btn" onclick="event.stopPropagation();ignore('${s.id}')">Ignore</button>
        <button class="btn dict" onclick="event.stopPropagation();addToDict('${s.id}')">＋ Dict</button>
      </div>
    </div>`).join('');
}
window.focusSugg = function(id){
  const ed=editor$();
  const span = ed.getDoc().querySelector(`.sugg[data-id="${id}"]`);
  if(span){
    span.scrollIntoView({behavior:'smooth',block:'center'});
    span.classList.add('flash');
    setTimeout(()=>span.classList.remove('flash'),700);
    openPopover(id, span);
  }
};

/* ---- utils ---- */
function updateCtx(){
  const ed=editor$(); if(!ed) return;
  const clone = ed.getBody().cloneNode(true);
  clone.querySelectorAll('.tstamp, .s-new').forEach(n=>n.remove());
  $('ctxLen').textContent = (clone.textContent||'').replace(/\s+/g,' ').trim().length;
}
function tstamp(){ const d=new Date(); return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function escapeReg(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
let toastT=null;
function flash(msg){ const t=$('toast'); $('toastMsg').textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2200); }
