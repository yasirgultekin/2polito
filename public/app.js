import { Quiz } from './quiz.js';
import { Analysis } from './analysis.js';
import { Flashcards } from './flashcards.js';

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const state = { courses: [], hasKey: false, model: '' };

/* ───────── helpers ───────── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2600);
}

// Markdown + LaTeX. Math is pulled out before Markdown so `_` and `*` inside
// formulas are not mangled, then rendered with KaTeX after sanitising.
function md(src) {
  const math = [];
  let text = String(src ?? '');
  const stash = (tex, display) => `@@M${math.push({ tex, display }) - 1}@@`;
  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => stash(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => stash(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => stash(t, false))
    .replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, pre, t) => pre + stash(t, false));
  // Citations like [slides-03.pdf p.12] → styled tag
  text = text.replace(/\[([^\[\]\n]+?\.(?:pdf|md|txt))(?:,?\s*p(?:age)?\.?\s*(\d+))?\]/gi,
    (_, f, p) => `<span class="cite">${esc(f.split('/').pop())}${p ? ` · p.${p}` : ''}</span>`);

  let html = DOMPurify.sanitize(marked.parse(text, { breaks: false, gfm: true }));
  html = html.replace(/@@M(\d+)@@/g, (_, i) => {
    const m = math[+i];
    try { return katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false }); }
    catch { return esc(m.tex); }
  });
  return html;
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

/* ───────── router ───────── */
async function boot() {
  try {
    const data = await api('/api/courses');
    Object.assign(state, data);
  } catch (e) {
    app.innerHTML = `<div class="empty-state"><h3>Server offline</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  const led = $('#linkState .led');
  led.className = 'led ' + (state.hasKey ? 'on' : 'warn');
  $('#linkText').textContent = state.hasKey ? 'agent online' : 'no api key';
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  const [, page, id] = location.hash.split('/');
  if (page === 'course' && id) {
    const course = state.courses.find(c => c.id === id);
    if (course?.unlocked) return renderCourse(course, location.hash.split('/')[3] || 'tutor');
    location.hash = '#/';
    return;
  }
  renderHome();
}

/* ───────── home ───────── */
const lockSvg = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="5.5" width="8" height="5.5"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>';

function renderHome() {
  $('#crumb').textContent = '/ panel';
  app.replaceChildren($('#tpl-home').content.cloneNode(true));
  $('#portCount').textContent = String(state.courses.length).padStart(2, '0');
  $('#modelInfo').textContent = state.model ? `tutor model · ${state.model}` : '';

  const sorted = [...state.courses].sort((a, b) => (b.unlocked - a.unlocked) || (b.year - a.year) || a.semester - b.semester);
  $('#ports').innerHTML = sorted.map((c, i) => `
    <a class="port ${c.unlocked ? 'live' : 'locked'}" ${c.unlocked ? `href="#/course/${c.id}"` : 'role="button" aria-disabled="true"'} data-id="${c.id}">
      <div class="port-top">
        <span class="port-num mono">PORT ${String(i + 1).padStart(2, '0')}</span>
        <span class="port-jack"><span class="led ${c.unlocked ? 'on' : ''}"></span></span>
      </div>
      <div>
        <span class="port-code">${esc(c.code)} · Y${c.year} S${c.semester}</span>
        <h3>${esc(c.name)}</h3>
      </div>
      <div class="port-foot mono">
        ${c.unlocked
          ? `<span>${c.credits} CFU · link up</span><span class="cta">enter <span>→</span></span>`
          : `<span>${c.credits} CFU</span><span class="lock">${lockSvg} no carrier</span>`}
      </div>
    </a>`).join('');

  $('#ports').addEventListener('click', e => {
    const p = e.target.closest('.port.locked');
    if (!p) return;
    p.classList.remove('shake'); void p.offsetWidth; p.classList.add('shake');
    toast('Port locked — this course is not live yet');
  });
}

/* ───────── course ───────── */
function renderCourse(course, tab) {
  $('#crumb').textContent = `/ ${course.code.toLowerCase()} / ${tab}`;
  app.replaceChildren($('#tpl-course').content.cloneNode(true));
  $('#courseTag').textContent = `${course.code} · Year ${course.year} · ${course.credits} CFU`;
  $('#courseName').textContent = course.name;
  $('#courseBlurb').textContent = course.blurb || '';

  const setTab = t => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === t));
    $('#crumb').textContent = `/ ${course.code.toLowerCase()} / ${t}`;
    history.replaceState(null, '', `#/course/${course.id}/${t}`);
    if (t === 'tutor') $('#input')?.focus();
  };
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    setTab(b.dataset.tab);
    // On narrow screens the rail sits above the content: jump to the content.
    if (window.matchMedia('(max-width: 960px)').matches) $('.stage')?.scrollIntoView({ behavior: 'smooth' });
  }));

  const tutor = Tutor(course);
  Materials(course);
  const askTutor = prompt => { setTab('tutor'); tutor.send(prompt); };
  const isActive = v => () => $(`.view[data-view="${v}"]`)?.classList.contains('active');
  api(`/api/courses/${course.id}/exams`)
    .then(data => {
      const cards = Flashcards($('#cards'), course, data, { api, esc, md, toast, askTutor, isActive: isActive('cards') });
      const studyCards = topics => { setTab('cards'); cards.study(topics); };
      Quiz($('#quiz'), course, data, { esc, toast, askTutor, studyCards, isActive: isActive('exams') });
      Quiz($('#forge'), course, data, {
        esc, toast, askTutor, studyCards, isActive: isActive('forge'), variant: 'generate',
        generate: params => api(`/api/courses/${course.id}/generate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
        }),
      });
      Analysis($('#analysis'), course, data, { esc, md, toast, askTutor, studyCards });
    })
    .catch(e => {
      const html = `<div class="empty-state"><h3>Questions offline</h3><p>${esc(e.message)}</p></div>`;
      $('#quiz').innerHTML = html; $('#forge').innerHTML = html; $('#analysis').innerHTML = html; $('#cards').innerHTML = html;
    });
  setTab(['exams', 'forge', 'analysis', 'cards'].includes(tab) ? tab : 'tutor');
}

/* ───────── materials ───────── */
function Materials(course) {
  const list = $('#matList'), status = $('#matStatus'), drop = $('#drop'), input = $('#fileInput');
  let timer;

  const paint = s => {
    clearTimeout(timer);
    const label = { ready: 'indexed', indexing: 'indexing…', error: 'error', idle: state.hasKey ? 'idle' : 'no key' }[s.status] || s.status;
    status.innerHTML = `<span class="led ${s.status === 'ready' ? 'on' : s.status === 'error' || !state.hasKey ? 'warn' : ''}"></span>${label}${s.chunks ? ` · ${s.chunks}` : ''}`;
    status.title = s.error || '';
    list.innerHTML = s.files.length
      ? s.files.map(f => `<li title="${esc(f.file)}"><span>${esc(f.file)}</span><span>${f.pages > 1 ? f.pages + 'p' : ''} ${f.chunks}ch</span></li>`).join('')
      : `<li class="empty">No material yet. Drop the professor's slides here or put them in <code>materials/${course.id}/</code>.</li>`;
    if (s.status === 'indexing') timer = setTimeout(load, 1500);
  };
  const load = () => api(`/api/courses/${course.id}/materials`).then(paint).catch(e => (status.textContent = e.message));

  async function upload(files) {
    if (!files.length) return;
    const fd = new FormData();
    [...files].forEach(f => fd.append('files', f));
    status.innerHTML = '<span class="led"></span>uploading…';
    setTimeout(load, 600);
    try {
      const r = await api(`/api/courses/${course.id}/materials`, { method: 'POST', body: fd });
      paint(r);
      toast(r.uploaded.length ? `${r.uploaded.length} file(s) uploaded & indexed` : 'Only PDF, MD or TXT files are accepted');
    } catch (e) { toast(e.message); load(); }
  }

  input.addEventListener('change', () => { upload(input.files); input.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files); });
  $('#reindex').addEventListener('click', async () => {
    status.innerHTML = '<span class="led"></span>indexing…';
    try { paint(await api(`/api/courses/${course.id}/reindex`, { method: 'POST' })); toast('Index refreshed'); }
    catch (e) { toast(e.message); load(); }
  });
  load();
}

/* ───────── tutor ───────── */
const SUGGESTIONS = [
  ['Concept', 'Explain the difference between distance-vector and link-state routing, with an example.'],
  ['Exercise', 'Give me a subnetting exercise on a /22 network and walk me through the solution.'],
  ['Compare', 'TCP vs UDP: when and why would I pick each? Make a table.'],
  ['Exam prep', 'What are the most important topics in the course material for the exam?'],
];

function Tutor(course) {
  const KEY = `bb.chat.${course.id}`;
  const chat = $('#chat'), input = $('#input'), form = $('#composer'), sendBtn = $('#send');
  let msgs = [];
  try { msgs = JSON.parse(localStorage.getItem(KEY)) || []; } catch {}
  let busy = false;

  const inner = document.createElement('div');
  inner.className = 'chat-inner';
  chat.append(inner);

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(msgs.slice(-60))); } catch {} };
  const scroll = () => { chat.scrollTop = chat.scrollHeight; };

  function intro() {
    return `<div class="intro">
      <p class="eyebrow mono">tutor · ${esc(course.code)}</p>
      <h3>Ask the course <em>anything.</em></h3>
      <p>Answers are pulled from your professor's material and cited by file and page. Write in English or Italian.</p>
      <div class="suggestions">${SUGGESTIONS.map(([k, q]) => `<button class="suggestion" data-q="${esc(q)}"><span class="mono">${k}</span>${esc(q)}</button>`).join('')}</div>
    </div>`;
  }

  function msgEl(m) {
    const el = document.createElement('div');
    el.className = `msg ${m.role === 'user' ? 'user' : 'bot'}`;
    if (m.role === 'user') {
      el.innerHTML = `<span class="msg-label mono">you</span><div class="bubble"></div>`;
      el.querySelector('.bubble').textContent = m.content;
    } else {
      el.innerHTML = `<span class="msg-label mono">tutor</span><div class="trace"></div><div class="body md"></div><div class="sources"></div>`;
      paintBot(el, m);
    }
    return el;
  }

  function paintBot(el, m, live = false) {
    el.querySelector('.trace').innerHTML = (m.trace || []).map((t, i, a) =>
      `<span class="trace-line ${live && i === a.length - 1 && !m.content ? 'running' : ''}">${t}</span>`).join('');
    const body = el.querySelector('.body');
    if (m.error) body.innerHTML = `<div class="err">${esc(m.error)}</div>`;
    else if (!m.content && live) body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    else body.innerHTML = md(m.content);
    el.querySelector('.sources').innerHTML = (m.sources || []).map(s =>
      `<span class="src">${esc(s.file.split('/').pop())}${s.page ? ` <b>p.${s.page}</b>` : ''}<span class="tip">${esc(s.snippet)}…</span></span>`).join('');
  }

  function paintAll() {
    inner.innerHTML = msgs.length ? '' : intro();
    msgs.forEach(m => inner.append(msgEl(m)));
    scroll();
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true;
    if (!msgs.length) inner.innerHTML = '';
    const user = { role: 'user', content: text };
    msgs.push(user);
    inner.append(msgEl(user));
    const bot = { role: 'assistant', content: '', trace: [], sources: [] };
    const botEl = msgEl(bot);
    inner.append(botEl);
    paintBot(botEl, bot, true);
    scroll();

    let raf = 0;
    const repaint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintBot(botEl, bot, true); scroll(); }); };

    try {
      const res = await fetch(`/api/courses/${course.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs.filter(m => !m.error).map(({ role, content }) => ({ role, content })) }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || 'null');
          if (type === 'token') bot.content += data;
          else if (type === 'status') bot.trace.push(data.kind === 'search' ? `› searching material <b>“${esc(data.query)}”</b>` : '› building index…');
          else if (type === 'sources') bot.sources = data;
          else if (type === 'error') bot.error = data.message;
          repaint();
        }
      }
    } catch (e) {
      bot.error = 'Connection lost: ' + e.message;
    }
    cancelAnimationFrame(raf);
    if (!bot.content && !bot.error) bot.error = 'No answer received.';
    msgs.push(bot);
    paintBot(botEl, bot);
    save(); scroll();
    busy = false; sendBtn.disabled = false;
    input.focus();
  }

  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', e => { e.preventDefault(); const v = input.value; input.value = ''; grow(); send(v); });
  chat.addEventListener('click', e => { const s = e.target.closest('.suggestion'); if (s) send(s.dataset.q); });
  $('#clearChat').addEventListener('click', () => { if (busy) return; msgs = []; save(); paintAll(); });

  paintAll();
  return { send };
}

boot();
