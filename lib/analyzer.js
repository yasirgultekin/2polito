// Exam analyzer: reads a student's exam export (PDF / photos), extracts every
// question with the chosen answer, determines the correct answers (official
// marks in the file → past-question bank → AI solving with course material),
// and writes a friendly report. Scoring itself is done client-side so the
// student can change the grading rule without re-running the analysis.

const L = i => String.fromCharCode(65 + i);
// Reasoning-style models (o-series, gpt-5) reject a custom temperature.
const det = model => (/^(o\d|gpt-5)/.test(model) ? {} : { temperature: 0 });
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = s => new Set(norm(s).split(' ').filter(t => t.length > 1));
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/* ───────── stage 1: extraction (vision) ───────── */
const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['exam_title', 'scoring_rule_text', 'questions'],
  properties: {
    exam_title: { type: 'string', description: 'Course / exam name and date if visible, else empty' },
    scoring_rule_text: { type: 'string', description: 'Any scoring rule stated in the document (points, penalties), else empty' },
    questions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['number', 'text', 'options', 'selected', 'selection_evidence', 'official_correct', 'official_points', 'max_points'],
        properties: {
          number: { type: 'integer' },
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: 'Option texts in order, without the (a)/(b) prefix' },
          selected: { type: 'integer', description: "0-based index of the option the student chose; -1 if no answer is given" },
          selection_evidence: { type: 'string', enum: ['radio_or_checkbox', 'highlight', 'handwritten', 'stated_in_text', 'none'] },
          official_correct: { type: 'integer', description: '0-based index of the correct option ONLY if the document explicitly shows it (e.g. "La risposta corretta è…", green tick); else -1' },
          official_points: { type: ['number', 'null'], description: 'Points obtained for this question if the document shows them (e.g. "Punteggio ottenuto 1,00 su 1,00"), else null' },
          max_points: { type: ['number', 'null'], description: 'Max points for this question if shown (e.g. "Punteggio max 1,00"), else null' },
        },
      },
    },
  },
};

async function extract({ openai, model, files }) {
  const parts = [{
    type: 'text',
    text: `These files are a student's Computer Networks exam (Politecnico di Torino, Moodle-style platform; Italian UI words like "Domanda", "Risposta", "Punteggio", "Risposta corretta" may appear). They can be a PDF export, screenshots or phone photos of the screen.
Extract EVERY multiple-choice question exactly once (if the same question appears on several pages/photos, merge it), in question-number order.
- "selected": the option the student picked — a filled radio/checkbox, a highlighted option, or a letter written/drawn by hand on the photo (e.g. a big "C" next to the question means option C). -1 if nothing indicates a choice.
- "official_correct" / "official_points": fill ONLY when the document explicitly shows them. Never guess them.
- Copy the question and option texts faithfully (English), fixing only obvious OCR glitches.`,
  }];
  for (const f of files) {
    const b64 = f.buffer.toString('base64');
    if (f.mimetype === 'application/pdf') parts.push({ type: 'file', file: { filename: f.originalname || 'exam.pdf', file_data: `data:application/pdf;base64,${b64}` } });
    else parts.push({ type: 'image_url', image_url: { url: `data:${f.mimetype};base64,${b64}`, detail: 'high' } });
  }
  const res = await openai.chat.completions.create({
    model,
    ...det(model),
    messages: [{ role: 'user', content: parts }],
    response_format: { type: 'json_schema', json_schema: { name: 'exam_extraction', strict: true, schema: EXTRACT_SCHEMA } },
  });
  const out = JSON.parse(res.choices[0].message.content || '{}');
  out.questions = (out.questions || []).filter(q => q.text && q.options?.length >= 2);
  return out;
}

/* ───────── stage 2: match against the past-question bank ───────── */
function matchBank(q, bank) {
  let best = null;
  for (const b of bank.questions) {
    const s = jaccard(q.text, b.text);
    if (!best || s > best.score) best = { b, score: s };
  }
  if (!best || best.score < 0.55) return { near: best?.score > 0.3 ? best.b : null };
  // Map the bank's correct option onto this exam's option order.
  const correctText = best.b.options[best.b.answer];
  const sims = q.options.map(o => jaccard(o, correctText));
  const k = sims.indexOf(Math.max(...sims));
  if (sims[k] < 0.5) return { near: best.b };
  return { match: best.b, answer: k, score: best.score };
}

/* ───────── stage 3: solve unmatched questions ───────── */
async function solve({ openai, model, index, bank, items }) {
  const topicIds = bank.topics.map(t => t.id);
  const contexts = await Promise.all(items.map(async it => {
    let ex = [];
    try { if (index?.chunks?.length) ex = await index.search(`${it.q.text} ${it.q.options.join(' ')}`, 3); } catch {}
    return ex;
  }));
  const body = items.map((it, i) => {
    const ref = it.near ? `\nSimilar past question (may differ!): ${it.near.text} → correct: "${it.near.options[it.near.answer]}"` : '';
    const mat = contexts[i].map(e => `[${e.file.split('/').pop()}${e.page ? ` p.${e.page}` : ''}] ${e.text.slice(0, 900)}`).join('\n');
    return `### Item ${i} (exam question ${it.q.number})\n${it.q.text}\n${it.q.options.map((o, k) => `${L(k)}) ${o}`).join('\n')}${ref}\nMaterial:\n${mat || '(none)'}`;
  }).join('\n\n');

  const schema = {
    type: 'object', additionalProperties: false, required: ['answers'],
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['item', 'topic', 'work', 'answer', 'confidence', 'explanation'],
          properties: {
            item: { type: 'integer', description: 'The Item index given in the heading' },
            topic: { type: 'string', enum: topicIds },
            work: { type: 'string', description: 'Private reasoning: check every option against the material.' },
            answer: { type: 'integer', description: '0-based index of the correct option' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            explanation: { type: 'string', description: 'One or two sentences for the student explaining why the option at index `answer` is correct; must agree with `answer`. Cite [file p.N] when from material.' },
          },
        },
      },
    },
  };
  const res = await openai.chat.completions.create({
    model,
    ...det(model),
    messages: [
      { role: 'system', content: 'You are a Computer Networks examiner at Politecnico di Torino. For EVERY item (answer each item exactly once, keeping its Item index) determine the single correct option. Read questions carefully (watch for "false", "not", "certainly"). Use the course material excerpts as ground truth. Be honest with confidence: "low" when material does not settle it.' },
      { role: 'user', content: body },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'exam_answers', strict: true, schema } },
  });
  return JSON.parse(res.choices[0].message.content || '{}').answers || [];
}

/* ───────── stage 4: friendly report ───────── */
async function report({ openai, model, language, rows, estimate, topicLabel }) {
  const lines = rows.map(r => `Q${r.number} [${topicLabel[r.topic] || 'unknown'}] ${r.status}${r.confidence === 'low' ? ' (uncertain key)' : ''}: ${r.text.slice(0, 140)}`).join('\n');
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['headline', 'summary', 'strengths', 'weak_spots', 'next_steps'],
    properties: {
      headline: { type: 'string', description: 'One short warm sentence' },
      summary: { type: 'string', description: '2 short paragraphs, Markdown allowed' },
      strengths: { type: 'array', items: { type: 'string' } },
      weak_spots: { type: 'array', items: { type: 'string' }, description: 'Concrete concepts to review, not just topic names' },
      next_steps: { type: 'array', items: { type: 'string' } },
    },
  };
  const res = await openai.chat.completions.create({
    model,
    ...det(model),
    messages: [
      { role: 'system', content: `You are a kind but honest study mentor for a Politecnico di Torino student. Write in ${language}. Speak directly to the student ("you"), warm and human, no corporate tone, no exaggerated praise. Mention the estimated grade naturally (Italian scale, out of 30, 18 = pass). If some answer keys are uncertain, say the grade is an estimate. Keep technical terms in English.` },
      { role: 'user', content: `Estimated grade: ${estimate.grade}/30 (range ${estimate.min}–${estimate.max}). Correct ${estimate.right}, wrong ${estimate.wrong}, blank ${estimate.blank} of ${rows.length}. Rule used: ${estimate.rule}.\n\nPer question:\n${lines}` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'exam_report', strict: true, schema } },
  });
  return JSON.parse(res.choices[0].message.content || '{}');
}

/* default grading used for the narrative; the UI can re-grade */
export function grade(rows, rule = { right: 1, wrong: 0, blank: 0, mode: 'cap' }) {
  let pts = 0, min = 0, max = 0, right = 0, wrong = 0, blank = 0;
  const maxPts = rows.reduce((s, r) => s + (r.maxPoints || 1), 0);
  for (const r of rows) {
    const w = r.maxPoints || 1;
    const val = r.status === 'right' ? rule.right * w : r.status === 'wrong' ? -rule.wrong * w : rule.blank * w;
    const alt = r.status === 'right' ? -rule.wrong * w : r.status === 'wrong' ? rule.right * w : val;
    pts += val;
    if (r.status === 'right') right++; else if (r.status === 'wrong') wrong++; else blank++;
    if (r.uncertain && r.status !== 'blank') { min += Math.min(val, alt); max += Math.max(val, alt); }
    else { min += val; max += val; }
  }
  const scale = v => Math.max(0, rule.mode === 'scale' ? (v / (maxPts * rule.right || 1)) * 30 : Math.min(v, 30));
  const r1 = v => Math.round(v * 10) / 10;
  return { points: r1(pts), grade: r1(scale(pts)), min: r1(scale(min)), max: r1(scale(max)), right, wrong, blank, maxPts,
    rule: `+${rule.right} correct, −${rule.wrong} wrong, ${rule.blank} blank, ${rule.mode === 'scale' ? 'scaled to 30' : 'capped at 30'}` };
}

export async function analyzeExam({ openai, model, index, bank, files, language, emit }) {
  const topicLabel = Object.fromEntries(bank.topics.map(t => [t.id, t.label]));

  emit('stage', { key: 'read', label: `Reading ${files.length} file${files.length > 1 ? 's' : ''}` });
  const ex = await extract({ openai, model, files });
  if (!ex.questions.length) throw new Error('No multiple-choice questions found in the file. Is it the exam export?');
  emit('stage', { key: 'read', label: `Found ${ex.questions.length} questions`, done: true });

  emit('stage', { key: 'match', label: 'Matching with past exam questions' });
  const rows = ex.questions.map(q => {
    const row = { number: q.number, text: q.text, options: q.options, selected: q.selected, evidence: q.selection_evidence, maxPoints: q.max_points || null };
    if (q.official_correct >= 0 && q.official_correct < q.options.length) Object.assign(row, { correct: q.official_correct, source: 'official', confidence: 'high' });
    const m = matchBank(q, bank);
    if (m.match) {
      row.topic = m.match.topic;
      row.bankId = m.match.id;
      if (row.source !== 'official') Object.assign(row, { correct: m.answer, source: 'bank', confidence: 'high', explanation: m.match.hint });
    } else row.near = m.near || null;
    if (q.official_points != null) row.officialPoints = q.official_points;
    return row;
  });
  const fromBank = rows.filter(r => r.source === 'bank').length;
  emit('stage', { key: 'match', label: `${fromBank} matched past questions`, done: true });

  const todo = rows.filter(r => r.source == null || !r.topic);
  if (todo.length) {
    emit('stage', { key: 'solve', label: `Solving ${todo.length} question${todo.length > 1 ? 's' : ''} with the course material` });
    const answers = await solve({ openai, model, index, bank, items: todo.map(r => ({ q: r, near: r.near })) });
    for (const a of answers) {
      const r = todo[a.item];
      if (!r) continue;
      r.topic ||= a.topic;
      if (r.source == null && a.answer >= 0 && a.answer < r.options.length) Object.assign(r, { correct: a.answer, source: 'ai', confidence: a.confidence, explanation: a.explanation });
    }
    emit('stage', { key: 'solve', label: 'Answer key complete', done: true });
  }

  for (const r of rows) {
    delete r.near;
    if (r.correct == null) { r.correct = -1; r.source = 'unknown'; r.confidence = 'low'; }
    r.status = r.selected < 0 ? 'blank' : r.selected === r.correct ? 'right' : 'wrong';
    r.uncertain = r.source === 'unknown' || (r.source === 'ai' && r.confidence !== 'high');
  }

  emit('stage', { key: 'report', label: 'Writing your report' });
  const estimate = grade(rows);
  const narrative = await report({ openai, model, language, rows, estimate, topicLabel });
  emit('stage', { key: 'report', label: 'Report ready', done: true });

  const nums = rows.map(r => r.number);
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i).length;
  return {
    warning: dupes ? `This file seems to contain more than one exam or attempt (${dupes} repeated question numbers). The grade below mixes them — upload one exam at a time for a reliable estimate.` : null,
    title: ex.exam_title,
    scoringRuleText: ex.scoring_rule_text,
    officialTotal: rows.every(r => r.officialPoints != null) ? rows.reduce((s, r) => s + r.officialPoints, 0) : null,
    rows,
    narrative,
    language,
  };
}
