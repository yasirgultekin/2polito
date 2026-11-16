// Flashcards with spaced repetition (SM-2 style, simplified to 3 ratings).
// Progress lives in localStorage; the deck itself is shared (server JSON).

const MIN = 60e3, DAY = 864e5;
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const fmtIv = ms => ms < 60 * MIN ? `${Math.max(1, Math.round(ms / MIN))}m` : ms < DAY ? `${Math.round(ms / (60 * MIN))}h` : ms < 30 * DAY ? `${Math.round(ms / DAY)}d` : `${(ms / (30 * DAY)).toFixed(1)}mo`;

// rating: 1 = forgot, 2 = hard, 3 = good
function schedule(prev, rating, now) {
  const s = { iv: 0, ease: 2.5, reps: 0, lapses: 0, ...(prev || {}) };
  let requeue = null;
  if (rating === 1) {
    s.lapses++; s.ease = Math.max(1.3, s.ease - 0.2); s.iv = 0; s.due = now + MIN; requeue = 3;
  } else if (rating === 2) {
    s.ease = Math.max(1.3, s.ease - 0.15);
    if (s.iv === 0) { s.due = now + 10 * MIN; requeue = 6; }
    else { s.iv = Math.max(1, s.iv * 1.2); s.due = now + s.iv * DAY; }
  } else {
    s.iv = s.iv === 0 ? 1 : Math.round(s.iv * s.ease * 10) / 10;
    s.due = now + s.iv * DAY;
  }
  s.reps++; s.last = now;
  return { s, requeue };
}

export function Flashcards(root, course, bank, { api, esc, md, toast, askTutor, isActive }) {
  const KS = `bb.fc.state.${course.id}`;
  const KL = `bb.fc.log.${course.id}`;
  const KP = `bb.fc.prefs.${course.id}`;
  const topicLabel = Object.fromEntries((bank.topics || []).map(t => [t.id, t.label]));
  let deck = { cards: [] }, flagged = new Set();
  let st = load(KS, {});
  let prefs = { topics: [], newPer: 20, cram: false, ...load(KP, {}) };
  let ses = null;
  let confirmRebuild = false;

  const savePrefs = () => store(KP, prefs);
  const live = () => deck.cards.filter(c => !flagged.has(c.id));
  const inSel = c => !prefs.topics.length || prefs.topics.includes(c.topic);

  function weakTopics() {
    const byId = new Map(bank.questions.map(q => [q.id, q.topic]));
    const w = {};
    for (const id of load(`bb.quiz.mistakes.${course.id}`, [])) { const t = byId.get(id); if (t) w[t] = (w[t] || 0) + 1; }
    const last = load(`bb.analysis.${course.id}`, [])[0];
    for (const r of last?.rows || []) if (r.status === 'wrong' && r.topic) w[r.topic] = (w[r.topic] || 0) + 2;
    return w;
  }

  function counts(cards, now = Date.now()) {
    let due = 0, fresh = 0, learned = 0, mastered = 0;
    for (const c of cards) {
      const s = st[c.id];
      if (!s) fresh++;
      else { if (s.due <= now) due++; if (s.iv >= 1) learned++; if (s.iv >= 21) mastered++; }
    }
    return { due, fresh, learned, mastered, total: cards.length };
  }

  function streak() {
    const log = load(KL, {});
    let n = 0, t = Date.now();
    if (!log[dayKey(t)]) t -= DAY; // today not studied yet doesn't break the streak
    while (log[dayKey(t)]) { n++; t -= DAY; }
    return n;
  }

  /* ───────── setup ───────── */
  function setup() {
    ses = null;
    if (!deck.cards.length) return buildView();
    const all = live();
    const sel = all.filter(inSel);
    const c = counts(all), cs = counts(sel);
    const weak = weakTopics();
    const log = load(KL, {});
    const days = Array.from({ length: 28 }, (_, i) => { const k = dayKey(Date.now() - (27 - i) * DAY); return { k, n: log[k] || 0 }; });
    const maxDay = Math.max(1, ...days.map(d => d.n));
    const todayCount = prefs.cram ? sel.length : cs.due + Math.min(cs.fresh, prefs.newPer);
    const weakIds = Object.keys(weak).sort((a, b) => weak[b] - weak[a]);

    root.innerHTML = `
    <div class="qz-wrap">
      <header class="qz-head">
        <p class="eyebrow mono">flashcards · ${esc(course.code)}</p>
        <h3>Make it <em>stick.</em></h3>
        <p class="qz-lede">Short recall cards built from the past exam questions and your professor's slides. Rate yourself honestly — cards you forget come back in minutes, cards you know drift out to days and weeks.</p>
        <div class="qz-stats fc-stats">
          <div><b>${c.total}</b><span class="mono">cards</span></div>
          <div><b>${c.due}</b><span class="mono">due now</span></div>
          <div><b>${c.fresh}</b><span class="mono">not seen yet</span></div>
          <div><b>${c.mastered}</b><span class="mono">mastered</span></div>
          <div><b>${streak()}</b><span class="mono">day streak</span></div>
        </div>
      </header>

      <div class="qz-modes fc-modes">
        <section class="qz-sim">
          <span class="mono qz-mode">${prefs.cram ? 'cram session' : 'today'}</span>
          <div class="fc-today"><b>${todayCount}</b><span>${prefs.cram ? 'cards, shuffled, schedule ignored' : `card${todayCount === 1 ? '' : 's'} to review<br><span class="mono">${cs.due} due · ${Math.min(cs.fresh, prefs.newPer)} new</span>`}</span></div>
          <div class="fc-heat" title="last 28 days">${days.map(d => `<i style="--a:${d.n ? 0.25 + 0.75 * d.n / maxDay : 0}" title="${d.k}: ${d.n} reviews"></i>`).join('')}</div>
          <span class="mono fc-heat-label">last 28 days</span>
          <div class="fc-sim-actions">
            <button class="btn-send" data-act="start" ${todayCount ? '' : 'disabled'}><span>${prefs.cram ? 'Start cramming' : 'Start review'}</span><svg viewBox="0 0 20 20"><path d="M3 10h12M11 5l5 5-5 5" /></svg></button>
            ${weakIds.length ? `<button class="btn-ghost mono fc-weak-btn" data-act="weak">study weak topics (${weakIds.length}) →</button>` : ''}
          </div>
          ${!todayCount && !prefs.cram ? `<p class="forge-empty">All caught up for ${prefs.topics.length ? 'these topics' : 'now'}. Switch to cram mode or pick other topics.</p>` : ''}
        </section>

        <section class="qz-custom">
          <span class="mono qz-mode">configure</span>
          <div class="field">
            <span class="mono field-label">topics <em>· none selected = all</em></span>
            <div class="fc-topics">
              ${bank.topics.map(t => {
                const tc = all.filter(x => x.topic === t.id);
                if (!tc.length) return '';
                const k = counts(tc);
                const on = prefs.topics.includes(t.id);
                return `<button class="fc-topic ${on ? 'on' : ''}" data-topic="${t.id}">
                  <span class="fc-topic-name">${esc(t.label)}${weak[t.id] ? '<em class="mono">weak</em>' : ''}</span>
                  <span class="fc-topic-bar"><i style="width:${(k.learned / k.total) * 100}%"></i></span>
                  <span class="mono">${k.due ? `<b>${k.due}</b> due · ` : ''}${k.fresh} new · ${k.total}</span>
                </button>`;
              }).join('')}
            </div>
            ${prefs.topics.length ? '<button class="btn-ghost mono fc-clear" data-act="all">clear selection</button>' : ''}
          </div>
          <div class="field-row">
            <div class="field">
              <span class="mono field-label">new cards per session</span>
              <div class="seg">${[10, 20, 40].map(n => `<button class="${prefs.newPer === n ? 'on' : ''}" data-new="${n}">${n}</button>`).join('')}</div>
            </div>
            <div class="field">
              <span class="mono field-label">mode</span>
              <div class="seg"><button class="${!prefs.cram ? 'on' : ''}" data-cram="0">Scheduled</button><button class="${prefs.cram ? 'on' : ''}" data-cram="1">Cram all</button></div>
            </div>
          </div>
          <p class="fc-note">${prefs.cram ? 'Cram mode goes through every card in the selection once, shuffled, and does not change your schedule — good the night before the exam.' : 'Scheduled mode shows cards that are due plus a few new ones. Forgotten cards come back within the same session.'}</p>
        </section>
      </div>
      <p class="qz-foot mono">keyboard · space flip · 1 forgot · 2 hard · 3 good
        · <button class="btn-ghost mono fc-rebuild" data-act="rebuild">${confirmRebuild ? 'click again to rebuild the whole deck' : `deck: ${deck.cards.length} cards${deck.builtAt ? `, built ${new Date(deck.builtAt).toLocaleDateString('en-GB')}` : ''} · rebuild`}</button></p>
    </div>`;
  }

  /* ───────── build ───────── */
  function buildView(progress) {
    root.innerHTML = `
    <div class="forge-loading fc-build">
      <div class="forge-pkts" aria-hidden="true">${'<i></i>'.repeat(5)}</div>
      ${progress ? `<h3>Building the deck<span class="dots"></span></h3>
        <p class="forge-meta mono">${progress.done}/${progress.total} topics</p>
        <ol class="an-stages">${progress.topics.map(t => `<li class="${t.state === 'done' ? 'done' : t.state === 'error' ? 'err' : 'run'}">${esc(t.label)}${t.count ? ` · ${t.count} cards` : ''}${t.error ? ` · ${esc(t.error)}` : ''}</li>`).join('')}</ol>`
      : `<h3>No deck yet</h3>
        <p class="fc-note">The deck is generated once from the past exam questions and the course material (about 260 cards, takes a minute or two) and then shared by everyone.</p>
        <button class="btn-ink" data-act="build">Build the deck →</button>`}
    </div>`;
  }

  async function build() {
    const progress = { done: 0, total: bank.topics.length, topics: [] };
    buildView(progress);
    try {
      const res = await fetch(`/api/courses/${course.id}/flashcards/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '', err = null;
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
          if (type === 'stage') Object.assign(progress, { done: d.done, total: d.total });
          else if (type === 'topic') { const t = progress.topics.find(x => x.id === d.id); t ? Object.assign(t, d) : progress.topics.push(d); }
          else if (type === 'error') err = d.message;
          buildView(progress);
        }
      }
      if (err) throw new Error(err);
      await refresh();
      toast(`Deck ready · ${deck.cards.length} cards`);
    } catch (e) { toast(e.message); await refresh(); }
  }

  /* ───────── session ───────── */
  function start({ cram = prefs.cram, topics = null } = {}) {
    const now = Date.now();
    const weak = weakTopics();
    const pool = live().filter(c => (topics ? topics.includes(c.topic) : inSel(c)));
    let queue;
    if (cram) queue = shuffle([...pool]);
    else {
      const due = pool.filter(c => st[c.id] && st[c.id].due <= now).sort((a, b) => st[a.id].due - st[b.id].due);
      const fresh = pool.filter(c => !st[c.id]).sort((a, b) => (weak[b.topic] || 0) - (weak[a.topic] || 0));
      const newOnes = fresh.slice(0, prefs.newPer);
      // Interleave: a new card after every two reviews keeps sessions varied.
      queue = [];
      while (due.length || newOnes.length) {
        queue.push(...due.splice(0, 2));
        if (newOnes.length) queue.push(newOnes.shift());
      }
    }
    if (!queue.length) {
      if (!cram && pool.length) return start({ cram: true, topics });
      return toast('No cards for this selection');
    }
    ses = { queue, cram, flipped: false, reviewed: 0, total: queue.length, stats: { 1: 0, 2: 0, 3: 0 }, started: now, label: topics ? 'weak topics' : prefs.topics.length === 1 ? topicLabel[prefs.topics[0]] : prefs.topics.length ? `${prefs.topics.length} topics` : 'all topics' };
    card();
  }

  function card() {
    if (!ses.queue.length) return finish();
    const c = ses.queue[0];
    const now = Date.now();
    const s = st[c.id];
    const isNew = !s;
    const prev = r => ses.cram ? '' : fmtIv(schedule(s, r, now).s.due - now);
    const pct = ses.reviewed / (ses.reviewed + ses.queue.length);

    root.innerHTML = `
    <div class="qz-run">
      <div class="qz-bar">
        <span class="mono qz-label">${ses.cram ? 'cram' : 'review'} · ${esc(ses.label)}</span>
        <div class="fc-progress"><i style="width:${pct * 100}%"></i></div>
        <span class="mono qz-count">${ses.queue.length} left</span>
        <button class="btn-ghost mono qz-finish" data-act="end">end</button>
      </div>
      <div class="fc-stage">
        <div class="fc-card ${ses.flipped ? 'flipped' : ''}" data-act="flip" role="button" tabindex="0" aria-label="flashcard, press space to flip">
          <div class="fc-face fc-front">
            <div class="fc-tags mono"><span>${esc(topicLabel[c.topic] || c.topic)}</span><span>${esc(c.kind || '')}</span>${isNew ? '<span class="fc-new">new</span>' : s.iv === 0 ? '<span class="fc-new">learning</span>' : ''}</div>
            <p class="fc-front-text">${esc(c.front)}</p>
            <span class="mono fc-tap">tap or press space to reveal</span>
          </div>
          <div class="fc-face fc-back">
            <div class="fc-tags mono"><span>answer</span></div>
            <p class="fc-q-small">${esc(c.front)}</p>
            <div class="fc-answer md">${md(c.back)}</div>
            ${c.source ? `<span class="cite fc-src">${esc(c.source)}</span>` : ''}
          </div>
        </div>
        <div class="fc-rate">
          ${ses.flipped ? `
            <button class="fc-btn r1" data-rate="1"><b>Forgot</b><span class="mono">1 · ${prev(1) || 'again'}</span></button>
            <button class="fc-btn r2" data-rate="2"><b>Hard</b><span class="mono">2 · ${prev(2) || 'soon'}</span></button>
            <button class="fc-btn r3" data-rate="3"><b>Good</b><span class="mono">3 · ${prev(3) || 'done'}</span></button>`
          : `<button class="btn-ink fc-show" data-act="flip">Show answer <span class="mono">space</span></button>`}
        </div>
        <div class="fc-extra">
          <button class="btn-ghost mono" data-act="ask">ask the tutor →</button>
          <button class="btn-ghost mono" data-act="flag">this card is wrong</button>
        </div>
      </div>
    </div>`;
  }

  function rate(r) {
    if (!ses?.flipped) return;
    const c = ses.queue.shift();
    const now = Date.now();
    ses.stats[r]++;
    ses.reviewed++;
    const log = load(KL, {}); log[dayKey(now)] = (log[dayKey(now)] || 0) + 1; store(KL, log);
    if (ses.cram) {
      if (r < 3) ses.queue.splice(Math.min(r === 1 ? 3 : 6, ses.queue.length), 0, c);
    } else {
      const { s, requeue } = schedule(st[c.id], r, now);
      st[c.id] = s; store(KS, st);
      if (requeue != null) ses.queue.splice(Math.min(requeue, ses.queue.length), 0, c);
    }
    ses.flipped = false;
    card();
  }

  function finish() {
    const s = ses;
    const now = Date.now();
    const tomorrow = live().filter(c => st[c.id] && st[c.id].due > now && st[c.id].due <= now + DAY).length;
    const secs = Math.round((now - s.started) / 1000);
    const recall = s.reviewed ? Math.round((s.stats[3] / s.reviewed) * 100) : 0;
    root.innerHTML = `
    <div class="qz-wrap qz-result fc-done">
      <p class="eyebrow mono">${s.cram ? 'cram' : 'review'} complete · ${Math.floor(secs / 60)}m ${secs % 60}s</p>
      <h3 class="fc-done-title">${s.reviewed ? `${s.reviewed} reviews, <em>${recall}%</em> recalled first time.` : 'Session ended.'}</h3>
      <div class="res-tiles an-tiles">
        <div class="right"><b>${s.stats[3]}</b><span class="mono">good</span></div>
        <div><b>${s.stats[2]}</b><span class="mono">hard</span></div>
        <div class="wrong"><b>${s.stats[1]}</b><span class="mono">forgot</span></div>
        <div><b>${tomorrow}</b><span class="mono">due within 24h</span></div>
      </div>
      <div class="qz-actions">
        <button class="btn-ink" data-act="setup">Back to deck →</button>
      </div>
    </div>`;
    ses = null;
  }

  async function flag() {
    const c = ses?.queue[0];
    if (!c) return;
    try {
      await api(`/api/courses/${course.id}/flashcards/flag`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id }) });
      flagged.add(c.id);
      ses.queue.shift();
      toast('Thanks — card hidden and reported for review');
      ses.flipped = false;
      card();
    } catch (e) { toast(e.message); }
  }

  /* ───────── events ───────── */
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act], [data-rate], [data-topic], [data-new], [data-cram]');
    if (!b) return;
    if (b.dataset.rate) return rate(+b.dataset.rate);
    if (b.dataset.topic) {
      const t = b.dataset.topic;
      prefs.topics = prefs.topics.includes(t) ? prefs.topics.filter(x => x !== t) : [...prefs.topics, t];
      savePrefs(); return setup();
    }
    if (b.dataset.new) { prefs.newPer = +b.dataset.new; savePrefs(); return setup(); }
    if (b.dataset.cram) { prefs.cram = b.dataset.cram === '1'; savePrefs(); return setup(); }
    switch (b.dataset.act) {
      case 'flip': if (ses) { ses.flipped = !ses.flipped; card(); } return;
      case 'start': return start();
      case 'weak': { const w = weakTopics(); return start({ topics: Object.keys(w), cram: prefs.cram }); }
      case 'all': prefs.topics = []; savePrefs(); return setup();
      case 'end': return ses?.reviewed ? finish() : setup();
      case 'setup': return setup();
      case 'build': return build();
      case 'rebuild':
        if (!confirmRebuild) { confirmRebuild = true; setTimeout(() => { confirmRebuild = false; }, 4000); return setup(); }
        confirmRebuild = false; return build();
      case 'flag': return flag();
      case 'ask': {
        const c = ses?.queue[0];
        if (c) askTutor(`Flashcard on ${topicLabel[c.topic] || c.topic}:\nQ: ${c.front}\nA: ${c.back.replace(/\*\*/g, '')}\n\nExplain this in more depth using the course material, and give me a quick example or a trick to remember it.`);
        return;
      }
    }
  });

  const onKey = e => {
    if (!root.isConnected) return document.removeEventListener('keydown', onKey);
    if (!isActive() || !ses || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); ses.flipped = !ses.flipped; card(); }
    else if (ses.flipped && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); rate(+e.key); }
  };
  document.addEventListener('keydown', onKey);

  async function refresh() {
    try {
      const d = await api(`/api/courses/${course.id}/flashcards`);
      deck = d; flagged = new Set(d.flagged || []);
    } catch (e) { toast(e.message); }
    setup();
  }
  refresh();

  return {
    // Called from Past questions / Exam analysis: study the cards of these topics now.
    study(topics) {
      const ids = [...new Set(topics)].filter(t => topicLabel[t]);
      if (!deck.cards.length) { setup(); return toast('Build the flashcard deck first'); }
      start({ topics: ids.length ? ids : null, cram: false });
    },
  };
}
