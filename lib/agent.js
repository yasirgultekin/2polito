// Tutor agent: an OpenAI tool-calling loop. The model decides when it needs the
// professor's material and calls `search_course_materials`; retrieved excerpts
// come back with file + page so the answer can cite them.

const MAX_STEPS = 4;

const tools = [
  {
    type: 'function',
    function: {
      name: 'search_course_materials',
      description:
        "Semantic search over the professor's uploaded material for this course (slides, notes, exercises). " +
        'Returns the most relevant excerpts with file name and page. Use focused queries in English (the material language). ' +
        'Call it again with a different query if the first results are not enough.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Focused search query, e.g. "TCP congestion avoidance additive increase"' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

function systemPrompt(course, index) {
  const fileList = index.files.map(f => `- ${f.file}`).join('\n') || '(no material uploaded yet)';
  return `You are the study tutor for the Politecnico di Torino course "${course.name}" (${course.code}).
Your job is to help a student understand the course and prepare for the exam.

Rules:
- Ground answers in the professor's material. Before answering any course-content question, call search_course_materials (once or a few times with focused queries).
- Cite sources inline as [file p.N] (or [file] when no page) right after the claim they support. Only cite excerpts you actually received.
- If the material does not cover something, say so clearly, then give a short answer from general networking knowledge, labelled "(general knowledge, not from course material)".
- Teach, don't just state: use step-by-step reasoning for numerical exercises (delays, throughput, subnetting, window sizes), show formulas and units.
- Reply in the same language the student writes in (English or Italian). Keep technical terms in English.
- Use Markdown: short paragraphs, lists, tables and \`code\` where helpful. Use LaTeX only inside $...$ or $$...$$.
- Be concise; offer to go deeper or to give a practice question at the end when useful.

Material currently indexed:
${fileList}`;
}

/**
 * Runs the agent and streams events through `emit(type, data)`.
 * Event types: status, sources, token, done, error.
 */
export async function runAgent({ openai, model, course, index, messages, emit }) {
  const convo = [
    { role: 'system', content: systemPrompt(course, index) },
    ...messages.slice(-16).map(m => ({ role: m.role, content: String(m.content).slice(0, 8000) })),
  ];

  const allSources = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const lastStep = step === MAX_STEPS - 1;
    const stream = await openai.chat.completions.create({
      model,
      messages: convo,
      tools,
      tool_choice: lastStep ? 'none' : 'auto',
      stream: true,
    });

    let content = '';
    const calls = [];
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        emit('token', delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const slot = (calls[tc.index] ||= { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }

    if (!calls.length) {
      emit('done', { sources: allSources });
      return;
    }

    convo.push({
      role: 'assistant',
      content: content || null,
      tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
    });

    for (const c of calls) {
      let result;
      try {
        const { query } = JSON.parse(c.args || '{}');
        emit('status', { kind: 'search', query });
        const hits = await index.search(query, 6);
        hits.forEach(h => {
          if (!allSources.some(s => s.file === h.file && s.page === h.page)) allSources.push({ file: h.file, page: h.page, snippet: h.text.slice(0, 280) });
        });
        emit('sources', allSources);
        result = hits.length
          ? hits.map(h => `[${h.file}${h.page ? ` p.${h.page}` : ''}] (score ${h.score})\n${h.text}`).join('\n\n---\n\n')
          : 'No material indexed or no relevant excerpt found.';
      } catch (err) {
        result = `Search failed: ${err.message}`;
      }
      convo.push({ role: 'tool', tool_call_id: c.id, content: result });
    }
  }
  emit('done', { sources: allSources });
}
