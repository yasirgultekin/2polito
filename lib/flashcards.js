// Flashcard deck builder: turns past exam questions + course material into
// short, atomic recall cards, one topic at a time. The deck is built once and
// stored in data/flashcards/<course>.json so every student sees the same cards
// (and wrong ones can be fixed by hand).
import fs from 'node:fs/promises';
import path from 'node:path';

const det = model => (/^(o\d|gpt-5)/.test(model) ? {} : { temperature: 0.2 });

export function deckPath(root, courseId) {
  return path.join(root, 'data/flashcards', `${courseId}.json`);
}
export function flagsPath(root, courseId) {
  return path.join(root, 'data/flashcards', `${courseId}.flags.json`);
}

export async function loadDeck(root, courseId) {
  try { return JSON.parse(await fs.readFile(deckPath(root, courseId), 'utf8')); }
  catch { return { course: courseId, cards: [] }; }
}

// "Past exam questions" / "PAST EXAM" / "06-LAN.pdf p.12" → one consistent label
function normSource(src) {
  const t = String(src || '').trim();
  if (/\.(pdf|md|txt)\b/i.test(t)) return t;
  if (/past\s*exam/i.test(t)) return 'past exams';
  return '';
}

function targetCount(bankCount) {
  return Math.max(12, Math.min(40, Math.round(bankCount * 0.5) + 10));
}

async function buildTopic({ openai, model, course, index, bank, topic }) {
  const questions = bank.questions.filter(q => q.topic === topic.id);
  const n = targetCount(questions.length);

  let excerpts = [];
  if (index?.chunks?.length) {
    const seen = new Set();
    const queries = [`${topic.label} key concepts definitions`, ...questions.slice(0, 3).map(q => q.text)];
    for (const q of queries) {
      for (const e of await index.search(q, 5)) {
        const k = `${e.file}:${e.page}`;
        if (!seen.has(k)) { seen.add(k); excerpts.push(e); }
      }
    }
    excerpts = excerpts.slice(0, 14);
  }

  const qText = questions.map(q => `- ${q.text} → ${q.options[q.answer]}${q.hint ? ` (${q.hint.slice(0, 220)})` : ''}`).join('\n') || '(no past questions on this topic)';
  const mText = excerpts.map(e => `[${e.file.split('/').pop()}${e.page ? ` p.${e.page}` : ''}]\n${e.text.slice(0, 1100)}`).join('\n\n---\n\n') || '(no material)';

  const schema = {
    type: 'object', additionalProperties: false, required: ['cards'],
    properties: {
      cards: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['front', 'back', 'kind', 'source'],
          properties: {
            front: { type: 'string', description: 'A short question or prompt (max ~18 words). Never a yes/no question.' },
            back: { type: 'string', description: 'The answer: 1–2 short sentences (max ~35 words). Key term in **bold**.' },
            kind: { type: 'string', enum: ['definition', 'fact', 'mechanism', 'comparison', 'number'] },
            source: { type: 'string', description: 'Material reference like "06-LAN.pdf p.12" if the fact comes from an excerpt, else empty string' },
          },
        },
      },
    },
  };

  const res = await openai.chat.completions.create({
    model, ...det(model),
    messages: [
      { role: 'system', content: `You write spaced-repetition flashcards for the Politecnico di Torino course "${course.name}". The exam is multiple choice and largely memory-based.
Rules:
- One atomic fact per card: a definition, a property, a mechanism step, a key number, or a "X vs Y" difference.
- Prioritise exactly the facts the past exam questions test (they show what the professor asks), then fill gaps from the material.
- Front: a precise recall prompt (e.g. "Which field of the IPv4 header prevents packets from looping forever?"). Not yes/no, not multiple choice, no "Explain…".
- Back: short and exact, the fact a student must remember; bold the key term.
- Facts must agree with the material excerpts; when a card relies on an excerpt put its reference in "source".
- No duplicates or near-duplicates. English. Plain text + **bold** only.` },
      { role: 'user', content: `Topic: ${topic.label}\nWrite ${n} cards.\n\n=== PAST EXAM QUESTIONS (question → correct answer) ===\n${qText}\n\n=== COURSE MATERIAL ===\n${mText}` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'flashcards', strict: true, schema } },
  });

  const cards = JSON.parse(res.choices[0].message.content || '{}').cards || [];
  const seen = new Set();
  return cards
    .filter(c => c.front?.trim() && c.back?.trim())
    .filter(c => { const k = c.front.toLowerCase().replace(/[^a-z0-9]/g, ''); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((c, i) => ({
      id: `${topic.id}-${String(i + 1).padStart(2, '0')}`,
      topic: topic.id,
      kind: c.kind,
      front: c.front.trim(),
      back: c.back.trim(),
      source: normSource(c.source),
    }));
}

export async function buildDeck({ root, openai, model, course, index, bank, topics, emit }) {
  const deck = await loadDeck(root, course.id);
  const todo = bank.topics.filter(t => !topics || topics.includes(t.id));
  let done = 0;
  const queue = [...todo];
  const results = {};

  emit('stage', { done: 0, total: todo.length, label: 'Starting' });
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      emit('topic', { id: t.id, label: t.label, state: 'run' });
      try {
        results[t.id] = await buildTopic({ openai, model, course, index, bank, topic: t });
        emit('topic', { id: t.id, label: t.label, state: 'done', count: results[t.id].length });
      } catch (err) {
        emit('topic', { id: t.id, label: t.label, state: 'error', error: err.message });
      }
      emit('stage', { done: ++done, total: todo.length });
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  // Replace rebuilt topics, keep the others.
  const rebuilt = new Set(Object.keys(results));
  const order = bank.topics.map(t => t.id);
  deck.cards = [...deck.cards.filter(c => !rebuilt.has(c.topic)), ...Object.values(results).flat()]
    .sort((a, b) => order.indexOf(a.topic) - order.indexOf(b.topic) || a.id.localeCompare(b.id));
  deck.model = model;
  deck.builtAt = new Date().toISOString();
  await fs.mkdir(path.dirname(deckPath(root, course.id)), { recursive: true });
  await fs.writeFile(deckPath(root, course.id), JSON.stringify(deck, null, 1));
  return deck;
}
