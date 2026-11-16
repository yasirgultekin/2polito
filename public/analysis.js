// Exam analysis: upload the exam export (PDF / photos), get the estimated
// grade out of 30 with a per-question breakdown and a friendly report.
// Grading happens here so the rule and misread answers can be fixed live.

const L = i => (i >= 0 ? String.fromCharCode(65 + i) : '—');
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const r1 = v => Math.round(v * 10) / 10;
const fmtSize = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;

function grade(rows, rule) {
  let pts = 0, min = 0, max = 0, right = 0, wrong = 0, blank = 0, maxPts = 0;
  for (const r of rows) {
    const w = r.maxPoints || 1;
    maxPts += w;
    const status = r.selected < 0 ? 'blank' : r.selected === r.correct ? 'right' : 'wrong';
    r.status = status;
    const val = status === 'right' ? rule.right * w : status === 'wrong' ? -rule.wrong * w : rule.blank * w;
    const alt = status === 'right' ? -rule.wrong * w : status === 'wrong' ? rule.right * w : val;
    pts += val;
    if (status === 'right') right++; else if (status === 'wrong') wrong++; else blank++;
    if (r.uncertain && status !== 'blank') { min += Math.min(val, alt); max += Math.max(val, alt); } else { min += val; max += val; }
  }
  const scale = v => Math.max(0, rule.mode === 'scale' ? (v / ((maxPts * rule.right) || 1)) * 30 : Math.min(v, 30));
  return { points: r1(pts), grade: r1(scale(pts)), min: r1(scale(min)), max: r1(scale(max)), right, wrong, blank, maxPts: r1(maxPts) };
}

export function Analysis(root, course, data, { esc, md, toast, askTutor, studyCards }) {
  const KH = `bb.analysis.${course.id}`;
  const KP = `bb.analysis.prefs.${course.id}`;
  const topicLabel = Object.fromEntries((data.topics || []).map(t => [t.id, t.label]));
  let prefs = { language: 'English', rule: { right: 1, wrong: 0, blank: 0, mode: 'cap' }, ...load(KP, {}) };
  if (!['English', 'Italian'].includes(prefs.language)) prefs.language = 'English';
  let files = [];
  let report = null;
  let open = new Set();

  /* ───────── upload screen ───────── */
  function setup() {
    report = null;
    const history = load(KH, []);
    root.innerHTML = `
    <div class="qz-wrap">
      <header class="qz-head">
        <p class="eyebrow mono">exam analysis · ${esc(course.code)}</p>
        <h3>How did the exam <em>really</em> go?</h3>
        <p class="qz-lede">Upload the PDF the exam platform gives you after the test — or photos of your screen. The agent reads every question and your answers, works out the correct key (past exams first, then the course material) and tells you, honestly, what you are likely to get out of 30.</p>
      </header>

      <div class="an-grid">
        <section class="an-upload">
          <label class="an-drop" id="anDrop">
            <input type="file" id="anInput" multiple accept="application/pdf,image/png,image/jpeg,image/webp" hidden />
            <span class="an-drop-icon" aria-hidden="true"><i></i><i></i><i></i></span>
            <b>Drop your exam PDF here</b>
            <span>or photos / screenshots · PDF, JPG, PNG · max 30 MB each</span>
          </label>
          <ul class="an-files">${files.map((f, i) => `<li><span class="mono">${f.type === 'application/pdf' ? 'PDF' : 'IMG'}</span><span class="name">${esc(f.name)}</span><span class="mono">${fmtSize(f.size)}</span><button class="btn-ghost mono" data-rm="${i}" aria-label="remove">✕</button></li>`).join('')}</ul>

          <div class="field-row an-opts">
            <div class="field">
              <span class="mono field-label">report language</span>
              <div class="seg">${[['English', 'English'], ['Italian', 'Italiano']].map(([k, v]) => `<button class="${prefs.language === k ? 'on' : ''}" data-lang="${k}">${v}</button>`).join('')}</div>
            </div>
          </div>
          ${ruleEditor()}
          <div class="qz-actions">
            <button class="btn-ink" data-act="analyze" ${files.length ? '' : 'disabled'}>Analyze my exam →</button>
          </div>
        </section>

        <section class="qz-sim an-side">
          <span class="mono qz-mode">what you get</span>
          <ol class="forge-steps">
            <li><b>01</b><span>Every question and the answer you marked — even from photos or handwritten letters</span></li>
            <li><b>02</b><span>The correct key: official marks in the file → matching past exam question → solved from the slides</span></li>
            <li><b>03</b><span>Your estimated grade out of 30, with a range when some keys are uncertain</span></li>
            <li><b>04</b><span>A human, honest read of how it went and what to review next</span></li>
          </ol>
          <div class="forge-sets">
            <span class="mono">past analyses</span>
            ${history.length ? history.map((h, i) => `<button class="forge-set" data-hist="${i}"><span>${esc(h.files?.[0] || 'exam')}</span><span class="mono">${h.estimate}/30 · ${new Date(h.at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span></button>`).join('') : '<p class="forge-empty">No analyses yet.</p>'}
          </div>
        </section>
      </div>
    </div>`;

    const drop = root.querySelector('#anDrop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
    root.querySelector('#anInput').addEventListener('change', e => addFiles(e.target.files));
  }

  function ruleEditor(r = prefs.rule) {
    return `<div class="field an-rule">
      <span class="mono field-label">grading rule <em>· 1 point per question on the PoliTo platform — change it if your exam had penalties</em></span>
      <div class="rule-row">
        <label><span class="mono">correct</span><span class="rule-in">+<input type="number" step="0.25" min="0" data-rule="right" value="${r.right}" /></span></label>
        <label><span class="mono">wrong</span><span class="rule-in">−<input type="number" step="0.05" min="0" data-rule="wrong" value="${r.wrong}" /></span></label>
        <label><span class="mono">blank</span><span class="rule-in"><input type="number" step="0.25" data-rule="blank" value="${r.blank}" /></span></label>
        <div class="seg">${[['cap', 'Cap at 30'], ['scale', 'Scale to 30']].map(([k, v]) => `<button class="${r.mode === k ? 'on' : ''}" data-mode="${k}">${v}</button>`).join('')}</div>
      </div>
    </div>`;
  }

  function addFiles(list) {
    const ok = [...list].filter(f => /^(application\/pdf|image\/(png|jpe?g|webp))$/.test(f.type));
    if (ok.length < list.length) toast('Only PDF, JPG, PNG or WEBP files');
    files = [...files, ...ok].slice(0, 12);
    setup();
  }

  /* ───────── processing ───────── */
  async function analyze() {
    const t0 = Date.now();
    const stages = [];
    root.innerHTML = `
    <div class="forge-loading an-loading">
      <div class="forge-pkts" aria-hidden="true">${'<i></i>'.repeat(6)}</div>
      <h3>Reading your exam<span class="dots"></span></h3>
      <p class="forge-meta mono"><span id="anClock">00:00</span> · usually 30–90 s</p>
      <ol class="an-stages" id="anStages"><li class="run">uploading ${files.length} file${files.length > 1 ? 's' : ''}</li></ol>
    </div>`;
    const clock = setInterval(() => {
      const el = root.querySelector('#anClock');
      if (!el) return clearInterval(clock);
      const s = Math.round((Date.now() - t0) / 1000);
      el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    const paintStages = () => {
      const el = root.querySelector('#anStages');
      if (el) el.innerHTML = stages.map(s => `<li class="${s.done ? 'done' : 'run'}">${esc(s.label)}</li>`).join('');
    };

    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    fd.append('language', prefs.language);
    let result = null, error = null;
    try {
      const res = await fetch(`/api/courses/${course.id}/analyze`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
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
          if (!type) continue;
          const d = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || 'null');
          if (type === 'stage') {
            const s = stages.find(x => x.key === d.key);
            if (s) Object.assign(s, d); else stages.push({ ...d });
            paintStages();
          } else if (type === 'result') result = d;
          else if (type === 'error') error = d.message;
        }
      }
    } catch (e) { error = e.message; }
    clearInterval(clock);

    if (error || !result) { setup(); toast(error || 'Analysis failed'); return; }
    result.rule = { ...prefs.rule };
    const est = grade(result.rows, result.rule);
    store(KH, [{ ...result, estimate: est.grade }, ...load(KH, [])].slice(0, 6));
    files = [];
    show(result);
  }

  /* ───────── report ───────── */
  function show(r) {
    report = r;
    report.rule ||= { ...prefs.rule };
    const g = grade(r.rows, report.rule);
    const n = r.narrative || {};
    const passed = g.grade >= 18;
    const srcCount = r.rows.reduce((m, x) => (m[x.source] = (m[x.source] || 0) + 1, m), {});
    const perTopic = {};
    r.rows.forEach(x => { const t = (perTopic[x.topic || 'unknown'] ||= { right: 0, total: 0 }); t.total++; if (x.status === 'right') t.right++; });
    const uncertain = r.rows.filter(x => x.uncertain).length;
    const rangeTxt = g.min !== g.max ? `${g.min}–${g.max}` : null;

    root.innerHTML = `
    <div class="qz-wrap an-report">
      <p class="eyebrow mono">exam analysis · ${esc(r.files?.join(', ') || '')} · ${new Date(r.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>

      <div class="an-hero">
        <div class="an-grade ${passed ? 'pass' : 'fail'}">
          <span class="mono">estimated grade</span>
          <b>${g.grade % 1 ? g.grade.toFixed(1) : g.grade}<small>/30</small></b>
          <span class="mono an-badge">${passed ? (g.grade >= 30 && g.points > 30 ? 'pass · lode territory' : 'pass') : 'below 18'}</span>
          ${rangeTxt ? `<span class="an-range mono">likely range ${rangeTxt} · ${uncertain} uncertain key${uncertain > 1 ? 's' : ''}</span>` : ''}
          ${r.officialTotal != null ? `<span class="an-range mono">official points in file: ${r.officialTotal}</span>` : ''}
        </div>
        <div class="an-words">
          <h4>${esc(n.headline || '')}</h4>
          <div class="md">${md(n.summary || '')}</div>
        </div>
      </div>

      ${r.warning ? `<div class="notice an-warn">${esc(r.warning)}</div>` : ''}
      <div class="res-tiles an-tiles">
        <div class="right"><b>${g.right}</b><span class="mono">correct</span></div>
        <div class="wrong"><b>${g.wrong}</b><span class="mono">wrong</span></div>
        <div><b>${g.blank}</b><span class="mono">blank</span></div>
        <div><b>${g.points}</b><span class="mono">points / ${g.maxPts}</span></div>
      </div>

      <div class="an-cols">
        <div><span class="mono field-label">what went well</span><ul>${(n.strengths || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
        <div><span class="mono field-label">review these</span><ul>${(n.weak_spots || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
        <div><span class="mono field-label">next steps</span><ul>${(n.next_steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
      </div>

      ${ruleEditor(report.rule)}

      <div class="res-topics">
        <span class="mono field-label">by topic</span>
        ${Object.entries(perTopic).sort((a, b) => b[1].total - a[1].total).map(([t, v]) => `
          <div class="res-topic"><span>${esc(topicLabel[t] || 'Other')}</span><span class="res-track"><i style="width:${(v.right / v.total) * 100}%"></i></span><span class="mono">${v.right}/${v.total}</span></div>`).join('')}
      </div>

      <div class="an-qs">
        <div class="an-qs-head">
          <span class="mono field-label">question by question</span>
          <span class="mono an-legend">key source: <b>pdf</b> ${srcCount.official || 0} · <b>past exam</b> ${srcCount.bank || 0} · <b>ai</b> ${srcCount.ai || 0}${srcCount.unknown ? ` · <b>unknown</b> ${srcCount.unknown}` : ''}</span>
        </div>
        <p class="an-tip">Did we misread one of your answers? Open the question and click the option you actually chose — the grade updates instantly.</p>
        ${r.rows.map((x, i) => row(x, i)).join('')}
      </div>

      <div class="qz-actions">
        <button class="btn-ink" data-act="new">Analyze another exam →</button>
        ${g.wrong + g.blank && studyCards ? '<button class="btn-line" data-act="cards">Flashcards for the topics you missed</button>' : ''}
      </div>
    </div>`;
  }

  function row(x, i) {
    const src = { official: 'pdf', bank: 'past exam', ai: `ai · ${x.confidence}`, unknown: 'no key' }[x.source];
    const isOpen = open.has(i);
    return `<article class="an-q ${x.status} ${isOpen ? 'open' : ''}">
      <button class="an-q-head" data-row="${i}">
        <span class="an-q-num mono">${String(x.number).padStart(2, '0')}</span>
        <span class="an-q-mark">${{ right: '✓', wrong: '✕', blank: '○' }[x.status]}</span>
        <span class="an-q-text">${esc(x.text)}</span>
        <span class="an-q-ans mono">you <b>${L(x.selected)}</b> · key <b>${L(x.correct)}</b></span>
        <span class="an-src mono ${x.uncertain ? 'warn' : ''}">${src}</span>
      </button>
      ${isOpen ? `
      <div class="an-q-body">
        <ol class="qz-opts">${x.options.map((o, k) => {
          const cls = k === x.correct ? 'right' : k === x.selected ? 'wrong' : 'dim';
          return `<li><button class="qz-opt ${cls} ${k === x.selected ? 'mine' : ''}" data-pick="${i}:${k}"><span class="k mono">${L(k)}</span><span>${esc(o)}${k === x.selected ? ' <em class="mono">your answer</em>' : ''}</span></button></li>`;
        }).join('')}</ol>
        <div class="an-q-foot">
          ${x.explanation ? `<p class="qz-exp-light">${md(x.explanation)}</p>` : ''}
          <div class="an-q-actions">
            <button class="btn-ghost mono" data-pick="${i}:-1">mark as blank</button>
            <button class="btn-ghost mono an-ask" data-ask="${i}">ask the tutor →</button>
          </div>
        </div>
      </div>` : ''}
    </article>`;
  }

  function persist() {
    const h = load(KH, []);
    const k = h.findIndex(x => x.at === report.at);
    if (k >= 0) { h[k] = { ...report, estimate: grade(report.rows, report.rule).grade }; store(KH, h); }
  }

  /* ───────── events ───────── */
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.rm != null) { files.splice(+b.dataset.rm, 1); return setup(); }
    if (b.dataset.lang) { prefs.language = b.dataset.lang; store(KP, prefs); return setup(); }
    if (b.dataset.mode) {
      prefs.rule.mode = b.dataset.mode; store(KP, prefs);
      if (report) { report.rule.mode = b.dataset.mode; persist(); return show(report); }
      return setup();
    }
    if (b.dataset.hist != null) { const h = load(KH, [])[+b.dataset.hist]; if (h) { open = new Set(); show(h); } return; }
    if (b.dataset.row != null) { const i = +b.dataset.row; open.has(i) ? open.delete(i) : open.add(i); return show(report); }
    if (b.dataset.pick) {
      const [i, k] = b.dataset.pick.split(':').map(Number);
      report.rows[i].selected = k;
      report.rows[i].evidence = 'corrected';
      persist();
      return show(report);
    }
    if (b.dataset.ask != null) {
      const x = report.rows[+b.dataset.ask];
      return askTutor(`I'm reviewing my exam. Question ${x.number}:\n\n${x.text}\n\n${x.options.map((o, k) => `${L(k)}) ${o}`).join('\n')}\n\nI answered ${L(x.selected)}; the key says ${L(x.correct)}. Explain which one is right and why, using the course material${x.selected !== x.correct ? ', and where my reasoning probably went wrong' : ''}.`);
    }
    if (b.dataset.act === 'analyze') return analyze();
    if (b.dataset.act === 'cards') return studyCards([...new Set(report.rows.filter(x => x.status !== 'right' && x.topic).map(x => x.topic))]);
    if (b.dataset.act === 'new') { open = new Set(); return setup(); }
  });
  root.addEventListener('change', e => {
    const k = e.target.dataset.rule;
    if (!k) return;
    const v = Math.max(k === 'blank' ? -5 : 0, parseFloat(e.target.value) || 0);
    prefs.rule[k] = v; store(KP, prefs);
    if (report) { report.rule[k] = v; persist(); show(report); }
  });

  setup();
}
