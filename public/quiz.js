// Past-question quiz engine: exam simulation (N random questions, timed) and
// custom practice (topic, count, order) with a persistent mistake log.
// Rules follow the original Portale dei Quiz: wrong or blank answers enter the
// mistake log; answering one correctly in "review mistakes" removes it; the
// score is computed over attempted questions.

const L = i => String.fromCharCode(65 + i);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export function Quiz(root, course, data, { esc, toast, askTutor, studyCards, isActive, variant = 'past', generate }) {
  const GEN = variant === 'generate';
  const KM = `bb.quiz.mistakes.${course.id}`;
  const KS = `bb.quiz.sims.${course.id}`;
  const KP = `bb.${GEN ? 'gen' : 'quiz'}.prefs.${course.id}`;
  const KG = `bb.gen.sets.${course.id}`;
  const SIM = { questions: 33, minutes: 60, ...(data.simulation || {}) };
  const all = data.questions;
  const byId = new Map(all.map(q => [q.id, q]));
  const topicLabel = Object.fromEntries((data.topics || []).map(t => [t.id, t.label]));
  const topics = (data.topics || []).map(t => ({ ...t, count: all.filter(q => q.topic === t.id).length }));

  let mistakes = load(KM, []).filter(id => byId.has(id));
  let prefs = { topic: 'all', count: GEN ? 5 : 10, random: true, difficulty: 'exam', ...load(KP, {}) };
  let lastGen = null; // params of the last generation, for "generate another"
  let run = null;   // active session
  let timer = null;
  let confirmClear = false;

  const saveMistakes = () => store(KM, mistakes);
  const stopTimer = () => { clearInterval(timer); timer = null; };

  /* ───────── setup ───────── */
  function setup() {
    stopTimer();
    run = null;
    if (GEN) return genSetup();
    const sims = load(KS, []);
    const best = sims.length ? Math.max(...sims.map(s => s.pct)) : null;
    const mistakesByTopic = mistakes.reduce((m, id) => { const t = byId.get(id)?.topic; m[t] = (m[t] || 0) + 1; return m; }, {});
    const pool = prefs.topic === 'all' ? all.length : topics.find(t => t.id === prefs.topic)?.count || 0;

    root.innerHTML = `
    <div class="qz-wrap">
      <header class="qz-head">
        <p class="eyebrow mono">past questions · ${esc(course.code)}</p>
        <h3>Practice like it's <em>exam day.</em></h3>
        <div class="qz-stats">
          <div><b>${all.length}</b><span class="mono">questions</span></div>
          <div><b>${topics.length}</b><span class="mono">topics</span></div>
          <div><b>${mistakes.length}</b><span class="mono">in mistake log</span></div>
          <div><b>${best == null ? '—' : best + '%'}</b><span class="mono">best simulation</span></div>
        </div>
      </header>

      <div class="qz-modes">
        <section class="qz-sim">
          <span class="mono qz-mode">mode a</span>
          <h4>Exam simulation</h4>
          <p>${SIM.questions} random questions across every topic, ${SIM.minutes} minutes on the clock. Scored at the end — like the real thing.</p>
          <div class="sim-specs mono"><span><b>${SIM.questions}</b>questions</span><span><b>${fmt(SIM.minutes * 60)}</b>time limit</span><span><b>${topics.length}</b>topics</span></div>
          ${sims.length ? `<div class="sim-history"><span class="mono">last runs</span><div class="sim-bars">${sims.slice(-10).map(s => `<i style="--h:${Math.max(s.pct, 3)}%" title="${s.pct}% · ${new Date(s.at).toLocaleDateString('en-GB')}"></i>`).join('')}</div></div>` : ''}
          <button class="btn-send" data-act="sim"><span>Start simulation</span><svg viewBox="0 0 20 20"><path d="M3 10h12M11 5l5 5-5 5" /></svg></button>
        </section>

        <section class="qz-custom">
          <span class="mono qz-mode">mode b</span>
          <h4>Custom practice</h4>

          <div class="field">
            <span class="mono field-label">topic</span>
            <div class="topic-list">
              <button class="topic ${prefs.topic === 'all' ? 'on' : ''}" data-topic="all"><span>All topics</span><span class="mono">${all.length}</span></button>
              ${topics.map(t => `<button class="topic ${prefs.topic === t.id ? 'on' : ''}" data-topic="${t.id}"><span>${esc(t.label)}</span><span class="mono">${mistakesByTopic[t.id] ? `<em>${mistakesByTopic[t.id]}✕</em> ` : ''}${t.count}</span></button>`).join('')}
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <span class="mono field-label">questions</span>
              <div class="stepper">
                <button data-act="dec" aria-label="fewer">−</button>
                <input type="number" id="qzCount" min="1" max="${pool}" value="${Math.min(prefs.count, pool)}" />
                <button data-act="inc" aria-label="more">+</button>
                <button class="mono stepper-all" data-act="max">all ${pool}</button>
              </div>
            </div>
            <div class="field">
              <span class="mono field-label">order</span>
              <div class="seg">
                <button class="${!prefs.random ? 'on' : ''}" data-order="seq">Sequential</button>
                <button class="${prefs.random ? 'on' : ''}" data-order="rnd">Random</button>
              </div>
            </div>
          </div>

          <div class="qz-actions">
            <button class="btn-ink" data-act="practice">Start practice →</button>
            <button class="btn-line" data-act="mistakes" ${mistakes.length ? '' : 'disabled'}>Review mistakes (${mistakes.length})</button>
          </div>
          ${mistakes.length ? `<button class="btn-ghost mono qz-clear" data-act="clear">${confirmClear ? 'click again to confirm — clear history' : 'clear mistake history'}</button>` : ''}
        </section>
      </div>
      <p class="qz-foot mono">keyboard · A–E or 1–5 choose · ⏎ submit / next · H hint</p>
    </div>`;
  }

  function readCount() {
    const el = root.querySelector('#qzCount');
    const v = Math.max(1, Math.min(+el.max, parseInt(el.value, 10) || 1));
    el.value = v;
    prefs.count = v;
    store(KP, prefs);
    return v;
  }

  /* ───────── session ───────── */
  function start(mode, preset) {
    let list;
    if (preset) list = preset;
    else if (mode === 'sim') list = shuffle([...all]).slice(0, SIM.questions);
    else if (mode === 'mistakes') {
      list = mistakes.map(id => byId.get(id)).filter(Boolean);
      if (prefs.random) shuffle(list);
    } else {
      list = prefs.topic === 'all' ? [...all] : all.filter(q => q.topic === prefs.topic);
      if (prefs.random) shuffle(list);
      list = list.slice(0, readCount());
    }
    if (!list.length) return toast('No questions for this selection');

    run = {
      mode, list, meta: preset?.meta, i: 0, picked: -1, done: false, hintOpen: false, confirmFinish: false,
      results: list.map(() => null), // 'right' | 'wrong' | 'blank' | null
      answers: list.map(() => -1),
      remaining: mode === 'sim' ? SIM.minutes * 60 : null,
      startedAt: Date.now(),
    };
    if (mode === 'sim') {
      timer = setInterval(() => {
        if (!root.isConnected) return stopTimer();
        run.remaining--;
        const t = root.querySelector('.qz-timer');
        if (t) { t.textContent = fmt(Math.max(run.remaining, 0)); t.classList.toggle('low', run.remaining < 300); }
        if (run.remaining <= 0) { toast('Time is up!'); finish(); }
      }, 1000);
    }
    question();
  }

  function question() {
    const q = run.list[run.i];
    const n = run.list.length;
    const label = { sim: 'exam simulation', practice: prefs.topic === 'all' ? 'practice · all topics' : `practice · ${topicLabel[prefs.topic]}`, mistakes: 'mistake review', gen: `generated · ${run.meta?.topic === 'all' ? 'all topics' : topicLabel[run.meta?.topic] || ''} · ${run.meta?.difficulty || ''}` }[run.mode];
    const res = run.results[run.i];
    const enter = run.shown !== run.i; // animate only when a new question appears
    run.shown = run.i;

    root.innerHTML = `
    <div class="qz-run">
      <div class="qz-bar">
        <span class="mono qz-label">${esc(label)}</span>
        <div class="qz-progress" style="--n:${n}">${run.results.map((r, k) => `<i class="${r || ''} ${k === run.i ? 'cur' : ''}"></i>`).join('')}</div>
        <span class="mono qz-count">${String(run.i + 1).padStart(2, '0')} / ${n}</span>
        ${run.remaining != null ? `<span class="mono qz-timer ${run.remaining < 300 ? 'low' : ''}">${fmt(run.remaining)}</span>` : ''}
        <button class="btn-ghost mono qz-finish ${run.confirmFinish ? 'warn' : ''}" data-act="finish">${run.confirmFinish ? 'sure? finish now' : 'finish'}</button>
      </div>

      <article class="qz-card ${enter ? 'enter' : ''}">
        <div class="qz-meta">
          <span class="qz-num">${run.i + 1}</span>
          <span class="mono qz-topic">${esc(topicLabel[q.topic] || q.topic)}</span>
        </div>
        <p class="qz-q">${esc(q.text)}</p>
        <ol class="qz-opts">
          ${q.options.map((o, k) => {
            let cls = '';
            if (run.done) { if (k === q.answer) cls = 'right'; else if (k === run.picked) cls = 'wrong'; else cls = 'dim'; }
            else if (k === run.picked) cls = 'picked';
            return `<li><button class="qz-opt ${cls}" data-opt="${k}" ${run.done ? 'disabled' : ''}><span class="k mono">${L(k)}</span><span>${esc(o)}</span></button></li>`;
          }).join('')}
        </ol>

        ${!run.done && run.hintOpen ? `<div class="qz-hint"><span class="mono">hint</span>${esc(q.hint || 'No hint available.')}</div>` : ''}

        ${run.done ? `
        <div class="qz-feedback ${res}">
          <span class="mono qz-verdict">${{ right: '✓ correct', wrong: '✕ incorrect', blank: '○ left blank' }[res]}</span>
          <p class="qz-answer">Answer <b>${L(q.answer)}</b> — ${esc(q.options[q.answer])}</p>
          ${q.hint ? `<p class="qz-exp">${esc(q.hint)}</p>` : ''}
          <button class="btn-ghost mono qz-ask" data-act="ask">ask the tutor to explain →</button>
        </div>` : ''}

        <div class="qz-controls">
          ${run.done
            ? `<span></span><button class="btn-ink" data-act="next">${run.i < n - 1 ? 'Next question →' : 'See results →'}</button>`
            : `<div class="qz-left">
                 ${q.hint ? `<button class="btn-ghost mono" data-act="hint">${run.hintOpen ? 'hide hint' : 'show hint'}</button>` : ''}
                 <button class="btn-ghost mono" data-act="blank">leave blank</button>
               </div>
               <button class="btn-ink" data-act="submit" ${run.picked < 0 ? 'disabled' : ''}>Submit answer</button>`}
        </div>
      </article>
    </div>`;
  }

  function submit(blank = false) {
    if (run.done) return;
    const q = run.list[run.i];
    if (!blank && run.picked < 0) return;
    if (blank) run.picked = -1;
    const right = !blank && run.picked === q.answer;
    run.results[run.i] = blank ? 'blank' : right ? 'right' : 'wrong';
    run.answers[run.i] = run.picked;
    if (run.mode === 'gen') { /* generated questions stay out of the mistake log */ }
    else if (right) {
      if (run.mode === 'mistakes') mistakes = mistakes.filter(id => id !== q.id);
    } else if (!mistakes.includes(q.id)) mistakes.push(q.id);
    saveMistakes();
    run.done = true;
    run.hintOpen = false;
    question();
  }

  function next() {
    if (run.i >= run.list.length - 1) return finish();
    run.i++;
    run.picked = -1;
    run.done = false;
    run.hintOpen = false;
    run.confirmFinish = false;
    question();
  }

  /* ───────── results ───────── */
  function finish() {
    stopTimer();
    const r = run;
    const attempted = r.results.filter(Boolean).length;
    const right = r.results.filter(x => x === 'right').length;
    const wrong = r.results.filter(x => x === 'wrong').length;
    const blank = r.list.length - right - wrong;
    const pct = Math.round((right / (attempted || 1)) * 100);
    const elapsed = Math.round((Date.now() - r.startedAt) / 1000);

    if (r.mode === 'sim' && attempted) store(KS, [...load(KS, []), { at: Date.now(), pct, right, total: r.list.length }].slice(-20));

    const perTopic = {};
    r.list.forEach((q, k) => {
      const t = (perTopic[q.topic] ||= { right: 0, total: 0 });
      t.total++;
      if (r.results[k] === 'right') t.right++;
    });
    const missed = r.list.map((q, k) => ({ q, k })).filter(({ k }) => r.results[k] && r.results[k] !== 'right');

    root.innerHTML = `
    <div class="qz-wrap qz-result">
      <p class="eyebrow mono">${{ sim: 'simulation', mistakes: 'mistake review', gen: 'generated set', practice: 'practice' }[r.mode]} complete · ${fmt(elapsed)} elapsed</p>
      <div class="res-top">
        <div class="res-score" style="--p:${pct}"><b>${pct}<small>%</small></b><span class="mono">on ${attempted} attempted</span></div>
        <div class="res-tiles">
          <div class="right"><b>${right}</b><span class="mono">correct</span></div>
          <div class="wrong"><b>${wrong}</b><span class="mono">incorrect</span></div>
          <div><b>${blank}</b><span class="mono">blank</span></div>
        </div>
      </div>

      <div class="res-topics">
        <span class="mono field-label">by topic</span>
        ${Object.entries(perTopic).sort((a, b) => b[1].total - a[1].total).map(([t, v]) => `
          <div class="res-topic"><span>${esc(topicLabel[t] || t)}</span><span class="res-track"><i style="width:${(v.right / v.total) * 100}%"></i></span><span class="mono">${v.right}/${v.total}</span></div>`).join('')}
      </div>

      ${missed.length ? `
      <details class="res-missed">
        <summary class="mono">review ${missed.length} missed question${missed.length > 1 ? 's' : ''}</summary>
        ${missed.map(({ q, k }) => `
          <div class="missed">
            <p>${esc(q.text)}</p>
            <p class="mono">${r.answers[k] >= 0 ? `<span class="bad">yours ${L(r.answers[k])}</span> · ` : '<span class="bad">blank</span> · '}<span class="good">correct ${L(q.answer)}</span> — ${esc(q.options[q.answer])}</p>
            <button class="btn-ghost mono" data-ask="${q.id}">ask the tutor →</button>
          </div>`).join('')}
      </details>` : ''}

      <div class="qz-actions">
        ${missed.length && studyCards ? `<button class="btn-line" data-act="cards">Flashcards for missed topics</button>` : ''}
        ${r.mode === 'gen'
          ? `<button class="btn-ink" data-act="regen">Generate another set →</button><button class="btn-line" data-act="replay">Replay this set</button><button class="btn-line" data-act="setup">Back</button>`
          : `<button class="btn-ink" data-act="again">${r.mode === 'sim' ? 'New simulation' : 'Try again'} →</button><button class="btn-line" data-act="setup">Back to modes</button>`}
      </div>
    </div>`;
    run = { ...r, finished: true };
  }

  function ask(q) {
    askTutor(`Help me understand this past exam question (topic: ${topicLabel[q.topic] || q.topic}). Explain why the correct answer is right and why the others are wrong, using the course material.\n\n${q.text}\n\n${q.options.map((o, k) => `${L(k)}) ${o}`).join('\n')}\n\nCorrect answer: ${L(q.answer)}`);
  }


  /* ───────── generator ───────── */
  function genSetup() {
    const sets = load(KG, []);
    root.innerHTML = `
    <div class="qz-wrap">
      <header class="qz-head">
        <p class="eyebrow mono">question forge · ${esc(course.code)}</p>
        <h3>Forge <em>new</em> questions.</h3>
        <p class="qz-lede">Pick a topic and how many questions you want. The agent studies the past exam questions on that topic, checks the facts against your professor's material, and writes fresh questions in the same style.</p>
      </header>

      <div class="qz-modes gen">
        <section class="qz-custom">
          <span class="mono qz-mode">configure</span>
          <div class="field">
            <span class="mono field-label">topic</span>
            <div class="topic-list">
              <button class="topic ${prefs.topic === 'all' ? 'on' : ''}" data-topic="all"><span>Mixed — all topics</span><span class="mono">${all.length} past</span></button>
              ${topics.map(t => `<button class="topic ${prefs.topic === t.id ? 'on' : ''}" data-topic="${t.id}"><span>${esc(t.label)}</span><span class="mono">${t.count} past</span></button>`).join('')}
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <span class="mono field-label">questions to create</span>
              <div class="stepper">
                <button data-act="dec" aria-label="fewer">−</button>
                <input type="number" id="qzCount" min="1" max="20" value="${Math.min(prefs.count, 20)}" />
                <button data-act="inc" aria-label="more">+</button>
              </div>
            </div>
            <div class="field">
              <span class="mono field-label">difficulty</span>
              <div class="seg">
                ${[['easy', 'Easier'], ['exam', 'Exam-like'], ['hard', 'Harder']].map(([k, v]) => `<button class="${prefs.difficulty === k ? 'on' : ''}" data-diff="${k}">${v}</button>`).join('')}
              </div>
            </div>
          </div>
          <div class="qz-actions">
            <button class="btn-ink" data-act="generate">Generate questions →</button>
          </div>
        </section>

        <section class="qz-sim">
          <span class="mono qz-mode">how it's made</span>
          <ol class="forge-steps">
            <li><b>01</b><span>Samples past exam questions on the topic as style references</span></li>
            <li><b>02</b><span>Retrieves the matching pages of the course material</span></li>
            <li><b>03</b><span>Writes new questions, one correct answer each, with an explanation</span></li>
            <li><b>04</b><span>Shuffles options — then you solve them like a normal quiz</span></li>
          </ol>
          <div class="forge-sets">
            <span class="mono">recent sets</span>
            ${sets.length ? sets.map((s, i) => `<button class="forge-set" data-set="${i}"><span>${esc(s.topic === 'all' ? 'Mixed topics' : topicLabel[s.topic] || s.topic)}</span><span class="mono">${s.questions.length}q · ${esc(s.difficulty)} · ${new Date(s.at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span></button>`).join('') : '<p class="forge-empty">Nothing generated yet.</p>'}
          </div>
        </section>
      </div>
    </div>`;
  }

  async function runGenerate(params) {
    lastGen = params;
    const steps = ['sampling past questions', 'reading course material', 'drafting questions', 'checking answers', 'shuffling options'];
    root.innerHTML = `
    <div class="forge-loading">
      <div class="forge-pkts" aria-hidden="true">${'<i></i>'.repeat(params.count)}</div>
      <h3>Forging ${params.count} question${params.count > 1 ? 's' : ''}<span class="dots"></span></h3>
      <p class="mono" id="forgeStep">${steps[0]}</p>
      <p class="forge-meta mono">${esc(params.topic === 'all' ? 'all topics' : topicLabel[params.topic])} · ${esc(params.difficulty)}</p>
    </div>`;
    let s = 0;
    const tick = setInterval(() => {
      const el = root.querySelector('#forgeStep');
      if (!el) return clearInterval(tick);
      s = Math.min(s + 1, steps.length - 1);
      el.textContent = steps[s];
    }, 2600);
    try {
      const out = await generate(params);
      clearInterval(tick);
      const set = { ...params, at: Date.now(), questions: out.questions, sources: out.sources };
      store(KG, [set, ...load(KG, [])].slice(0, 8));
      toast(out.grounded ? `${out.questions.length} questions · grounded on ${out.sources.length} material pages` : `${out.questions.length} questions generated (no material indexed)`);
      start('gen', Object.assign([...out.questions], { meta: set }));
    } catch (e) {
      clearInterval(tick);
      setup();
      toast(e.message);
    }
  }

  /* ───────── events ───────── */
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;

    if (b.dataset.topic) { prefs.topic = b.dataset.topic; store(KP, prefs); return setup(); }
    if (b.dataset.diff) { prefs.difficulty = b.dataset.diff; store(KP, prefs); return setup(); }
    if (b.dataset.set != null) { const set = load(KG, [])[+b.dataset.set]; if (set) start('gen', Object.assign([...set.questions], { meta: set })); return; }
    if (b.dataset.order) { prefs.random = b.dataset.order === 'rnd'; store(KP, prefs); return setup(); }
    if (b.dataset.opt != null && run && !run.done) { run.picked = +b.dataset.opt; return question(); }
    if (b.dataset.ask) return ask(byId.get(b.dataset.ask));

    switch (act) {
      case 'sim': return start('sim');
      case 'practice': return start('practice');
      case 'mistakes': return start('mistakes');
      case 'inc': case 'dec': case 'max': {
        const el = root.querySelector('#qzCount');
        el.value = act === 'max' ? el.max : (+el.value || 0) + (act === 'inc' ? 1 : -1);
        return readCount();
      }
      case 'clear':
        if (!confirmClear) { confirmClear = true; setTimeout(() => { confirmClear = false; }, 4000); return setup(); }
        confirmClear = false; mistakes = []; saveMistakes(); toast('Mistake history cleared'); return setup();
      case 'hint': run.hintOpen = !run.hintOpen; return question();
      case 'blank': return submit(true);
      case 'submit': return submit(false);
      case 'next': return next();
      case 'finish':
        if (!run.confirmFinish) { run.confirmFinish = true; question(); setTimeout(() => { if (run && !run.finished && run.confirmFinish) { run.confirmFinish = false; question(); } }, 3500); return; }
        return finish();
      case 'ask': return ask(run.list[run.i]);
      case 'cards': return studyCards([...new Set(run.list.filter((q, k) => run.results[k] && run.results[k] !== 'right').map(q => q.topic))]);
      case 'again': return start(run.mode === 'mistakes' && !mistakes.length ? 'practice' : run.mode);
      case 'setup': return setup();
      case 'generate': return runGenerate({ topic: prefs.topic, count: readCount(), difficulty: prefs.difficulty });
      case 'regen': return runGenerate(lastGen || { topic: prefs.topic, count: prefs.count, difficulty: prefs.difficulty });
      case 'replay': return start('gen', Object.assign([...run.list], { meta: run.meta }));
    }
  });
  root.addEventListener('change', e => { if (e.target.id === 'qzCount') readCount(); });

  const onKey = e => {
    if (!root.isConnected) return document.removeEventListener('keydown', onKey);
    if (!isActive() || !run || run.finished || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const q = run.list[run.i];
    const k = e.key.toLowerCase();
    if (!run.done && k.length === 1 && k >= 'a' && k < String.fromCharCode(97 + q.options.length)) { run.picked = k.charCodeAt(0) - 97; question(); }
    else if (!run.done && /^[1-9]$/.test(k) && +k <= q.options.length) { run.picked = +k - 1; question(); }
    else if (e.key === 'Enter') { e.preventDefault(); run.done ? next() : submit(false); }
    else if (!run.done && k === 'h' && q.hint) { run.hintOpen = !run.hintOpen; question(); }
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  setup();
}
