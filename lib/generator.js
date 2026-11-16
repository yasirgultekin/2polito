// Question generator: writes new exam-style MCQs for a topic, using past exam
// questions as style/difficulty examples and the professor's material as the
// factual ground truth.

const MAX_EXAMPLES = 14;
const L = i => String.fromCharCode(65 + i);
const pick = (arr, n) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};

const DIFFICULTY = {
  easy: 'Easier than the exam: direct definitions and core concepts, clearly distinguishable options.',
  exam: 'Same difficulty as the real exam examples.',
  hard: 'Harder than the exam: subtle distractors, multi-step reasoning, small numerical exercises where the topic allows.',
};

export async function generateQuestions({ openai, model, course, index, bank, topic, count, difficulty }) {
  const topics = bank.topics || [];
  const label = Object.fromEntries(topics.map(t => [t.id, t.label]));
  const allowed = topic === 'all' ? topics.map(t => t.id) : [topic];
  if (!allowed.every(t => label[t])) throw new Error('Unknown topic');

  // Style examples: random past questions from the chosen topic(s).
  const pool = bank.questions.filter(q => allowed.includes(q.topic));
  const examples = topic === 'all'
    ? allowed.flatMap(t => pick(pool.filter(q => q.topic === t), 2)).slice(0, MAX_EXAMPLES)
    : pick(pool, MAX_EXAMPLES);

  // Grounding: one retrieval over the material for the topic.
  let excerpts = [];
  if (index?.chunks?.length) {
    const query = topic === 'all'
      ? `${course.name} key concepts exam`
      : `${label[topic]}: ${examples.slice(0, 4).map(q => q.text).join(' | ')}`;
    excerpts = await index.search(query, topic === 'all' ? 10 : 8);
  }

  const exampleText = examples.map((q, i) =>
    `Example ${i + 1} [${label[q.topic]}]\nQ: ${q.text}\n${q.options.map((o, k) => `${L(k)}) ${o}`).join('\n')}\nCorrect: ${L(q.answer)}${q.hint ? `\nWhy: ${q.hint}` : ''}`).join('\n\n');
  const materialText = excerpts.length
    ? excerpts.map(e => `[${e.file}${e.page ? ` p.${e.page}` : ''}]\n${e.text}`).join('\n\n---\n\n')
    : '(no course material indexed — rely on standard Computer Networks knowledge consistent with the examples)';

  const system = `You write multiple-choice exam questions for the Politecnico di Torino course "${course.name}".
Write NEW questions that look like they come from the same exam: same tone, length, phrasing style and option format as the examples.
Rules:
- Exactly one correct option; 3 or 4 options (match the examples), all plausible, similar length, no "all of the above"/"none of the above".
- Do not copy or lightly paraphrase an example; test different facts or angles of the topic, and cover varied subtopics across the set.
- Every fact must agree with the course material excerpts when they are provided.
- Difficulty: ${DIFFICULTY[difficulty] || DIFFICULTY.exam}
- "explanation": 1–3 sentences on why the answer is correct (and, if useful, why a tempting distractor is wrong). Mention the source as [file p.N] only if it comes from a material excerpt. Never mention or cite the examples (no "Example N") — the student cannot see them.
- Before setting "answer", solve the question in "work" and check every option. Exactly one option must be correct; if your check shows none or several are correct, fix the options in your output (the final "options" must be consistent with "work").
- The "explanation" must be clean and confident: no self-corrections, no "however", no mention of option letters' positions.
- Write in English. Put the correct option anywhere; its position will be shuffled anyway.`;

  const user = `Topic: ${topic === 'all' ? 'all course topics (spread the questions across them)' : label[topic]}
Number of questions: ${count}

=== PAST EXAM EXAMPLES ===
${exampleText}

=== COURSE MATERIAL EXCERPTS ===
${materialText}`;

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          // Order matters: the model solves the question in `work` before it
          // commits to `answer`, which prevents wrong answer keys.
          required: ['topic', 'text', 'options', 'work', 'answer', 'explanation'],
          properties: {
            topic: { type: 'string', enum: allowed },
            text: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            work: { type: 'string', description: 'Private scratchpad: solve the question step by step and check every option. Not shown to the student.' },
            answer: { type: 'integer', description: '0-based index of the single correct option, as verified in work' },
            explanation: { type: 'string', description: 'Clean final explanation for the student, consistent with answer.' },
          },
        },
      },
    },
  };

  const res = await openai.chat.completions.create({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: { name: 'generated_questions', strict: true, schema } },
  });

  const raw = JSON.parse(res.choices[0].message.content || '{}').questions || [];
  const stamp = Date.now().toString(36);
  const questions = raw
    .filter(q => q.text && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 5 && q.answer >= 0 && q.answer < q.options.length)
    .slice(0, count)
    .map((q, i) => {
      // Shuffle options so the correct answer is not always in the same slot.
      const order = pick(q.options.map((_, k) => k), q.options.length);
      return {
        id: `gen-${stamp}-${i}`,
        topic: allowed.includes(q.topic) ? q.topic : allowed[0],
        text: q.text.trim(),
        options: order.map(k => q.options[k].trim()),
        answer: order.indexOf(q.answer),
        hint: q.explanation.trim(),
        generated: true,
      };
    });

  if (!questions.length) throw new Error('The model returned no valid questions, try again.');
  return {
    questions,
    grounded: excerpts.length,
    sources: [...new Set(excerpts.map(e => `${e.file.split('/').pop()}${e.page ? ` p.${e.page}` : ''}`))],
  };
}
