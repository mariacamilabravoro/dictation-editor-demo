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
      {type:"typo", find:"tecnica digital", old:"tecnica", nw:"técnica", kind:"mistake", msg:"Missing accent — “técnica”."}
    ]
  },
  {
    text: " punto y aparte HALLAZGOS Los campos pulmonares se encuentran bien espandidos punto Se identifica una lesion tumoral de 5 × 5 × 5 cm",
    secs: 9, trigger: "punto",
    fixes: [
      {type:"typo", find:"espandidos", old:"espandidos", nw:"expandidos", kind:"mistake", msg:"Spelling — “expandidos”."},
      {type:"typo", find:"lesion tumoral", old:"lesion", nw:"lesión", kind:"mistake", msg:"Missing accent — “lesión”."}
    ]
  },
  {
    text: " punto No se observa evidencia de otras consolidaciones, nodulos o masas punto El indice cardiotoracico se encuentra dentro de limites normales",
    secs: 10, trigger: "silence",
    fixes: [
      {type:"typo", find:"nodulos o masas", old:"nodulos", nw:"nódulos", kind:"mistake", msg:"Missing accent — “nódulos”."},
      {type:"style", find:"El indice cardiotoracico", old:"El indice cardiotoracico", nw:"El índice cardiotorácico", kind:"mistake", msg:"Accents — “índice cardiotorácico”."},
      {type:"grammar", find:"dentro de limites normales", old:"dentro de limites", nw:"dentro de límites", kind:"mistake", msg:"Missing accent — “límites”."}
    ]
  },
  {
    text: " punto y aparte Las estructuras oseas visualizadas no muestra alteraciones focales",
    secs: 6, trigger: "newline",
    fixes: [
      {type:"typo", find:"estructuras oseas", old:"oseas", nw:"óseas", kind:"mistake", msg:"Missing accent — “óseas”."},
      {type:"grammar", find:"visualizadas no muestra", old:"no muestra", nw:"no muestran", kind:"mistake", msg:"Agreement — plural subject needs “muestran”."}
    ]
  },
  {
    text: " punto La trama broncovascular es de aspecto conservado punto No se identifica derrame plural ni neumotorax",
    secs: 8, trigger: "punto",
    fixes: [
      {type:"typo", find:"derrame plural", old:"plural", nw:"pleural", kind:"warn", msg:"Spelling — “derrame pleural”, not “plural”."},
      {type:"typo", find:"ni neumotorax", old:"neumotorax", nw:"neumotórax", kind:"mistake", msg:"Missing accent — “neumotórax”."}
    ]
  },
  {
    text: " punto y aparte IMPRESION Lesion tumoral de 5 cm en campo pulmonar derecho, a correlacionar con antecedentes clinicos del paciente",
    secs: 9, trigger: "silence",
    fixes: [
      {type:"style", find:"IMPRESION", old:"IMPRESION", nw:"IMPRESIÓN", kind:"mistake", msg:"Missing accent — heading “IMPRESIÓN”."},
      {type:"typo", find:"Lesion tumoral", old:"Lesion", nw:"Lesión", kind:"mistake", msg:"Missing accent — “Lesión”."},
      {type:"style", find:"antecedentes clinicos", old:"clinicos", nw:"clínicos", kind:"mistake", msg:"Missing accent — “clínicos”."}
    ]
  }
];
SEGMENTS.forEach(b => b.fixes = b.fixes.filter(f => f.old !== f.nw));

const TRIGGER_LABEL = {
  punto:   "said “punto”",
  newline: "said “punto y aparte” → new line",
  silence: "6 s silence detected"
};

/* Every correction the corrector produced, undecided ones only:
   {id, type, kind, old, nw, msg, ts}. Whether a k-similar entry is already applied
   or still waiting for a decision is decided by the "Auto-apply fixes" switch,
   so flipping it re-reads this same list — nothing is re-run. */
let suggestions = [];
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

    /* Every mark carries BOTH the dictated word and the correction; CSS decides
       which one you read and whether it is underlined.

       k-mistake (gray)   plainly wrong — "espandidos", "tecnica", "no muestra".
                          "Auto-apply fixes" decides whether it is corrected on
                          its own or queued for approval.
       k-warn (yellow)    both words exist, the other fits the context better.
                          Always corrected, and flagged for a human to confirm. */
    .sugg{border-radius:2px;transition:background .15s;cursor:default;user-select:none;-webkit-user-select:none;}
    .sugg .s-old, .sugg .s-new{text-decoration:none;}
    .sugg.k-warn{cursor:pointer;}
    body:not(.auto-apply) .sugg.k-mistake{cursor:pointer;}
    .sugg.k-warn:hover,
    body:not(.auto-apply) .sugg.k-mistake:hover{background:rgba(255,255,255,.06);}
    /* TinyMCE marks a clicked contenteditable=false span data-mce-selected and its
       oxide skin draws a 3px blue outline on it — kill that, our own highlight below
       is the only "selected" affordance we want. */
    .sugg[data-mce-selected]{outline:none!important;}
    /* clicked open: a highlight in the underline's own color, not the browser's
       default blue selection box around the (contenteditable=false) span */
    .sugg.active{background:rgba(255,255,255,.12);}
    .sugg.k-warn.active{background:rgba(232,184,75,.22);}
    .sugg.k-mistake.active{background:rgba(139,149,163,.22);}

    /* -------- PANEL MODE -------- */

    /* WARNING: corrected, and underlined yellow so it never slips through */
    body:not(.inline) .sugg.k-warn .s-old{display:none;}
    body:not(.inline) .sugg.k-warn .s-new{display:inline;}
    body:not(.inline).show-warn .sugg.k-warn .s-new{
      border-bottom:2px solid #e8b84b;padding-bottom:1px;
    }

    /* TYPO, auto-apply on: already fixed. A dotted gray line marks what changed. */
    body:not(.inline).auto-apply .sugg.k-mistake .s-old{display:none;}
    body:not(.inline).auto-apply .sugg.k-mistake .s-new{display:inline;}
    body:not(.inline).auto-apply.show-mistake .sugg.k-mistake:not(.k-silent) .s-new{
      border-bottom:2px dotted #8b95a3;padding-bottom:1px;
    }

    /* TYPO, auto-apply off: the dictated word stays until it is accepted.
       A solid gray line marks what is still waiting. */
    body:not(.inline):not(.auto-apply) .sugg.k-mistake .s-old{display:inline;}
    body:not(.inline):not(.auto-apply) .sugg.k-mistake .s-new{display:none;}
    body:not(.inline):not(.auto-apply).show-mistake .sugg.k-mistake:not(.k-silent) .s-old{
      border-bottom:2px solid #8b95a3;padding-bottom:1px;
    }

    /* -------- INLINE MODE: track-changes, old struck through + new inserted -------- */
    body.inline .sugg{padding:0 2px;}
    body.inline .sugg .s-old{
      text-decoration:line-through;opacity:.6;margin-right:3px;
    }
    /* AUTO: nothing to track — the fix reads as ordinary text */
    body.inline.auto-apply .sugg.k-mistake .s-old{display:none;}
    body.inline.auto-apply .sugg.k-mistake .s-new{color:inherit;font-weight:400;}
    /* MANUAL: full track-changes on the pending fix */
    body.inline:not(.auto-apply) .sugg.k-mistake .s-old{display:inline;text-decoration-color:#8b95a3;color:#aeb7c3;}
    body.inline:not(.auto-apply) .sugg.k-mistake .s-new{color:#7fe0ad;font-weight:600;}
    /* a warning always shows both words — that is the whole point of it */
    body.inline .sugg.k-warn .s-old{text-decoration-color:#e8b84b;color:#e0c281;}
    body.inline .sugg.k-warn .s-new{color:#7fe0ad;font-weight:600;}

    .sugg.flash{background:rgba(232,184,75,.28)!important;}

    /* inline timing annotations — off unless enabled in the UI panel */
    body:not(.show-tstamp) .tstamp{display:none;}
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
    ed.on('init',()=>{ setupIframeEvents(ed); applyDispMode(); applyUiOpts(); });
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

/* ---- floating UI-options panel (bottom-left) ----
   Everything here is presentation only: it toggles classes on both the page body
   and the TinyMCE iframe body, so flipping a switch never re-runs the corrector. */
const UI_CLASS = {tstamp:'show-tstamp', auto:'auto-apply', warn:'show-warn', mistake:'show-mistake'};
const UI_STORE = 'edenmed.uiOpts.v3';
let uiOpts = loadUiOpts();

function loadUiOpts(){
  /* warnings are underlined out of the box — a word the radiologist may have
     actually meant must never be corrected behind their back. Plain typos are
     auto-applied and unmarked; switch on "Show typos" to audit them. */
  const off = {tstamp:false, auto:true, warn:true, mistake:false};
  try{
    const raw = localStorage.getItem(UI_STORE);
    return raw ? Object.assign(off, JSON.parse(raw)) : off;
  }catch(e){ return off; }
}
function saveUiOpts(){ try{ localStorage.setItem(UI_STORE, JSON.stringify(uiOpts)); }catch(e){} }

function applyUiOpts(){
  const ed = editor$();
  const bodies = [document.body];
  if(ed && ed.getBody()) bodies.push(ed.getBody());
  Object.keys(UI_CLASS).forEach(k=>{
    bodies.forEach(b=>b.classList.toggle(UI_CLASS[k], !!uiOpts[k]));
  });
  renderList();   // auto vs manual changes what the review panel is responsible for
}

document.querySelectorAll('.ui-sw').forEach(sw=>{
  sw.checked = !!uiOpts[sw.dataset.opt];
  sw.addEventListener('change',()=>{
    uiOpts[sw.dataset.opt] = sw.checked;
    saveUiOpts();
    hidePopover();
    applyUiOpts();
  });
});

const fab = $('uiFab');
function setFab(open){
  fab.classList.toggle('open', open);
  $('uiFabBtn').setAttribute('aria-expanded', String(open));
}
$('uiFabBtn').addEventListener('click', e=>{ e.stopPropagation(); setFab(!fab.classList.contains('open')); });
$('uiClose').addEventListener('click', e=>{ e.stopPropagation(); setFab(false); });
document.addEventListener('click', e=>{ if(!fab.contains(e.target)) setFab(false); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape') setFab(false); });
applyUiOpts();

/* ---- the two kinds of correction ----------------------------------------
   mistake (gray)   the dictated word is simply wrong — misspelled, missing an
                    accent, wrong number. There is no other reading of it.
   warn (yellow)    both words exist; the other one fits the context better
                    (“derrame plural” → “derrame pleural”). Needs a human.
   Each fix in SEGMENTS declares its own `kind`; this is only the fallback. */
const deaccent = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const stripPunct = s => s.trim().toLowerCase().replace(/[.,;:!\u00a1?\u00bf"'\u00ab\u00bb()\-\u2013\u2014]/g,'').replace(/\s+/g,' ');
/* accent- or punctuation-only fixes are too trivial to flag: same letters, just
   the tilde or a stop restored. Real misspellings still get the underline. */
const isSilent = (oldTxt, newTxt) => deaccent(oldTxt) === deaccent(newTxt) || stripPunct(oldTxt) === stripPunct(newTxt);
function changeKind(oldTxt, newTxt){
  const a = deaccent(oldTxt), b = deaccent(newTxt);
  if(a === b) return 'mistake';                       // accents / casing only
  let i = 0; while(i < a.length && i < b.length && a[i] === b[i]) i++;
  // shared stem with a reshaped ending = inflection, still just wrong;
  // anything else could be a real word the radiologist meant
  return (i >= 4 && Math.abs(a.length - b.length) <= 3) ? 'mistake' : 'warn';
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

  let mech = 0, ctx = 0;
  seg.fixes.forEach(fx=>{
    const id = 'sg'+(seq++);
    const kind = fx.kind || changeKind(fx.old, fx.nw);
    const ts = `${tStart}s→${tNow}s`;
    const safeOld = escapeReg(fx.old);
    // match the old token, but never inside an existing tag or an existing .sugg
    const re = new RegExp('(?![^<]*>)'+safeOld);
    if(!re.test(html)) return;

    // The mark always carries both words. Auto vs manual is a rendering decision,
    // so the same markup serves either mode and the switch works retroactively.
    const silentCls = isSilent(fx.old, fx.nw) ? ' k-silent' : '';
    html = html.replace(re,
      `<span class="sugg ${fx.type} k-${kind}${silentCls}" data-id="${id}" contenteditable="false">`+
      `<del class="s-old">${fx.old}</del>`+
      `<ins class="s-new">${fx.nw}</ins>`+
      `</span>`);

    suggestions.push({id, type:fx.type, kind, old:fx.old, nw:fx.nw, msg:fx.msg,
                      marked:true, ts, trig:seg.trigger});
    if(kind==='warn') ctx++; else mech++;
  });
  body.innerHTML = html;
  updateCtx();
  renderList();
  const parts = [];
  if(mech) parts.push(uiOpts.auto ? `${mech} typo${mech>1?'s':''} auto-fixed` : `${mech} typo${mech>1?'s':''} to accept`);
  if(ctx)  parts.push(`${ctx} warning${ctx>1?'s':''}`);
  if(parts.length) flash(`${parts.join(' · ')} · ${TRIGGER_LABEL[seg.trigger]}`);
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
  // once a popover is open, hovering another underlined word previews it too —
  // but hover alone never opens the first one, that still takes a click
  doc.addEventListener('mouseover', e=>{
    if(activeId === null) return;
    const t = e.target.closest('.sugg');
    if(t && t.dataset.id !== activeId) openPopover(t.dataset.id, t);
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
  const doc = el.ownerDocument;
  doc.querySelectorAll('.sugg.active').forEach(n=>n.classList.remove('active'));
  el.classList.add('active');
  // clicking a contenteditable=false span drops the browser's own blue
  // selection box on it; drop the native selection so only our highlight shows
  doc.defaultView.getSelection().removeAllRanges();
  const pop = $('popover');
  const iframe = document.querySelector('.tox-edit-area__iframe');
  const ir = iframe.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const top = ir.top + er.bottom + 6;
  let left = ir.left + er.left;
  left = Math.min(left, window.innerWidth - 262);

  // whatever kind of fix this is, the corrected word is already sitting in
  // the text — there's nothing to "accept". The only useful action from the
  // underline itself is putting the dictated word back.
  pop.innerHTML = `
    <div class="pop-top">
      <span class="tag ${s.type}">${s.type}</span>
    </div>
    <div class="change"><span class="old">${s.old}</span></div>
    <div class="card-actions">
      <button class="btn" onclick="revert('${s.id}')">Revert to “${s.old}”</button>
    </div>`;
  pop.style.display='block';
  pop.style.top = top+'px';
  pop.style.left = left+'px';
  renderList();
}
function hidePopover(){
  $('popover').style.display='none';
  activeId=null;
  const ed = editor$();
  if(ed && ed.getDoc()) ed.getDoc().querySelectorAll('.sugg.active').forEach(n=>n.classList.remove('active'));
  renderList();
}

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
window.revert = function(id){
  const ed=editor$(); const s=suggestions.find(x=>x.id===id); if(!s) return;
  const span = ed.getDoc().querySelector(`.sugg[data-id="${id}"]`);
  if(span){ span.replaceWith(ed.getDoc().createTextNode(s.old)); }
  remove(id, `Reverted → “${s.old}”`);
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
  // with auto-apply on, the mechanical fixes are already settled and drop off the panel
  const settled = uiOpts.auto ? suggestions.filter(s=>s.kind==='mistake').length : 0;
  const pending = uiOpts.auto ? suggestions.filter(s=>s.kind==='warn') : suggestions;

  $('count').textContent = pending.length + ' open' + (settled ? ` · ${settled} auto` : '');
  if(!pending.length){
    list.innerHTML = settled
      ? `<div class="empty" id="empty">No warnings.<br>${settled} typo${settled>1?'s':''} `+
        `${settled>1?'were':'was'} corrected automatically. Switch off <b>Auto-apply fixes</b> to approve them by hand.</div>`
      : '<div class="empty" id="empty">All clear.<br>Continue dictation to generate the next correction batch.</div>';
    return;
  }
  list.innerHTML = pending.map(s=>`
    <div class="card ${s.id===activeId?'active':''}" onclick="focusSugg('${s.id}')">
      <div class="card-top">
        <span class="tag k-${s.kind}">${s.kind==='warn'?'warning':'typo'}</span>
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
