import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CourseIndex } from './lib/indexer.js';
import { runAgent } from './lib/agent.js';
import { generateQuestions } from './lib/generator.js';
import { analyzeExam } from './lib/analyzer.js';
import { buildDeck, loadDeck, flagsPath } from './lib/flashcards.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
// Exam analysis reads photos/PDF pages and decides your grade: use a stronger vision model by default.
const ANALYSIS_MODEL = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-4.1';
// Flashcard deck is built once; set a stronger model here for higher card quality.
const FLASHCARD_MODEL = process.env.OPENAI_FLASHCARD_MODEL || MODEL;
const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

const openai = HAS_KEY ? new OpenAI() : null;
const courses = JSON.parse(await fs.readFile(path.join(ROOT, 'data/courses.json'), 'utf8'));
const indexes = new Map();

for (const c of courses.filter(c => c.unlocked)) {
  const idx = new CourseIndex({
    courseId: c.id,
    materialsDir: path.join(ROOT, 'materials', c.id),
    cacheDir: path.join(ROOT, '.cache'),
    openai,
    embedModel: EMBED_MODEL,
  });
  indexes.set(c.id, idx);
  if (HAS_KEY) idx.build().then(s => console.log(`[index] ${c.id}: ${s.status}, ${s.files.length} files, ${s.chunks} chunks`));
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

function unlockedCourse(req, res) {
  const course = courses.find(c => c.id === req.params.id);
  if (!course) { res.status(404).json({ error: 'Course not found' }); return null; }
  if (!course.unlocked) { res.status(423).json({ error: 'Course locked' }); return null; }
  return course;
}

app.get('/api/courses', (_req, res) => res.json({ courses, model: MODEL, hasKey: HAS_KEY }));

app.get('/api/courses/:id/materials', (req, res) => {
  if (!unlockedCourse(req, res)) return;
  res.json({ ...indexes.get(req.params.id).summary(), hasKey: HAS_KEY });
});

app.post('/api/courses/:id/reindex', async (req, res) => {
  if (!unlockedCourse(req, res)) return;
  if (!HAS_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY missing in .env' });
  res.json(await indexes.get(req.params.id).build());
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(ROOT, 'materials', req.params.id);
      fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir), cb);
    },
    filename: (_req, file, cb) => cb(null, path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8'))),
  }),
  fileFilter: (_req, file, cb) => cb(null, /\.(pdf|md|txt)$/i.test(file.originalname)),
  limits: { fileSize: 80 * 1024 * 1024 },
});

app.post('/api/courses/:id/materials', (req, res, next) => {
  if (!unlockedCourse(req, res)) return;
  next();
}, upload.array('files', 30), async (req, res) => {
  const idx = indexes.get(req.params.id);
  const summary = HAS_KEY ? await idx.build() : idx.summary();
  res.json({ uploaded: (req.files || []).map(f => f.filename), ...summary });
});

app.get('/api/courses/:id/exams', async (req, res) => {
  if (!unlockedCourse(req, res)) return;
  try {
    res.json(JSON.parse(await fs.readFile(path.join(ROOT, 'data/exams', `${req.params.id}.json`), 'utf8')));
  } catch {
    res.json({ course: req.params.id, exams: [] });
  }
});

app.post('/api/courses/:id/generate', async (req, res) => {
  const course = unlockedCourse(req, res);
  if (!course) return;
  if (!HAS_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY is not set. Add it to .env and restart the server.' });

  const topic = String(req.body?.topic || 'all');
  const count = Math.max(1, Math.min(20, parseInt(req.body?.count, 10) || 5));
  const difficulty = ['easy', 'exam', 'hard'].includes(req.body?.difficulty) ? req.body.difficulty : 'exam';

  try {
    const bank = JSON.parse(await fs.readFile(path.join(ROOT, 'data/exams', `${course.id}.json`), 'utf8'));
    const index = indexes.get(course.id);
    if (index.building) await index.building;
    res.json(await generateQuestions({ openai, model: MODEL, course, index, bank, topic, count, difficulty }));
  } catch (err) {
    console.error('[generate]', err);
    res.status(500).json({ error: err?.error?.message || err.message || 'Generation failed' });
  }
});

const examUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => cb(null, /^(application\/pdf|image\/(png|jpe?g|webp))$/.test(file.mimetype)),
  limits: { fileSize: 30 * 1024 * 1024, files: 12 },
});

app.post('/api/courses/:id/analyze', (req, res, next) => {
  if (!unlockedCourse(req, res)) return;
  examUpload.array('files', 12)(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 30 MB each)' : err.message });
    next();
  });
}, async (req, res) => {
  const course = courses.find(c => c.id === req.params.id);
  if (!HAS_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY is not set. Add it to .env and restart the server.' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Upload a PDF or photos of your exam (PDF, PNG, JPG, WEBP).' });
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > 45 * 1024 * 1024) return res.status(400).json({ error: 'Files are too large in total (max ~45 MB). Try fewer pages or compress the PDF.' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  try {
    const bank = JSON.parse(await fs.readFile(path.join(ROOT, 'data/exams', `${course.id}.json`), 'utf8'));
    const index = indexes.get(course.id);
    if (index.building) await index.building;
    const language = ['English', 'Italian'].includes(req.body?.language) ? req.body.language : 'English';
    const result = await analyzeExam({ openai, model: ANALYSIS_MODEL, index, bank, files, language, emit });
    emit('result', { ...result, files: files.map(f => f.originalname), at: Date.now() });
  } catch (err) {
    console.error('[analyze]', err);
    emit('error', { message: err?.error?.message || err.message || 'Analysis failed' });
  }
  clearInterval(ping);
  res.end();
});

/* ───────── flashcards ───────── */
app.get('/api/courses/:id/flashcards', async (req, res) => {
  if (!unlockedCourse(req, res)) return;
  const deck = await loadDeck(ROOT, req.params.id);
  let flags = [];
  try { flags = JSON.parse(await fs.readFile(flagsPath(ROOT, req.params.id), 'utf8')); } catch {}
  res.json({ ...deck, flagged: [...new Set(flags.map(f => f.id))], hasKey: HAS_KEY });
});

let deckBuilding = false;
app.post('/api/courses/:id/flashcards/build', async (req, res) => {
  const course = unlockedCourse(req, res);
  if (!course) return;
  if (!HAS_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY is not set. Add it to .env and restart the server.' });
  if (deckBuilding) return res.status(409).json({ error: 'A deck is already being built, wait for it to finish.' });
  deckBuilding = true;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const bank = JSON.parse(await fs.readFile(path.join(ROOT, 'data/exams', `${course.id}.json`), 'utf8'));
    const index = indexes.get(course.id);
    if (index.building) await index.building;
    const topics = Array.isArray(req.body?.topics) && req.body.topics.length ? req.body.topics : null;
    const deck = await buildDeck({ root: ROOT, openai, model: FLASHCARD_MODEL, course, index, bank, topics, emit });
    emit('result', { cards: deck.cards.length });
  } catch (err) {
    console.error('[flashcards]', err);
    emit('error', { message: err?.error?.message || err.message || 'Build failed' });
  } finally {
    deckBuilding = false;
    res.end();
  }
});

app.post('/api/courses/:id/flashcards/flag', async (req, res) => {
  if (!unlockedCourse(req, res)) return;
  const id = String(req.body?.id || '').slice(0, 80);
  if (!id) return res.status(400).json({ error: 'Missing card id' });
  const file = flagsPath(ROOT, req.params.id);
  let flags = [];
  try { flags = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  flags.push({ id, note: String(req.body?.note || '').slice(0, 500), at: new Date().toISOString() });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(flags, null, 1));
  res.json({ ok: true });
});

app.post('/api/courses/:id/chat', async (req, res) => {
  const course = unlockedCourse(req, res);
  if (!course) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  if (!HAS_KEY) {
    emit('error', { message: 'OPENAI_API_KEY is not set. Add it to .env and restart the server.' });
    return res.end();
  }

  const messages = Array.isArray(req.body?.messages) ? req.body.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant')) : [];
  if (!messages.length) { emit('error', { message: 'Empty conversation' }); return res.end(); }

  const index = indexes.get(course.id);
  if (index.building) { emit('status', { kind: 'indexing' }); await index.building; }

  try {
    await runAgent({ openai, model: MODEL, course, index, messages, emit });
  } catch (err) {
    console.error('[chat]', err);
    emit('error', { message: err?.error?.message || err.message || 'Agent failed' });
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`2Poli.TO portal → http://localhost:${PORT}`);
  if (!HAS_KEY) console.warn('⚠  OPENAI_API_KEY not set — copy .env.example to .env and fill it in.');
});
