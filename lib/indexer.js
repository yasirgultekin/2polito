// Material indexer: reads course files, chunks them, embeds with OpenAI and
// caches the vectors on disk keyed by file hash, so unchanged files are never
// re-embedded (no repeated cost, fast restarts).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const SUPPORTED = new Set(['.pdf', '.md', '.txt']);
const CHUNK_CHARS = 1400;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH = 96;

export class CourseIndex {
  constructor({ courseId, materialsDir, cacheDir, openai, embedModel }) {
    this.courseId = courseId;
    this.materialsDir = materialsDir;
    this.cacheFile = path.join(cacheDir, `${courseId}.json`);
    this.openai = openai;
    this.embedModel = embedModel;
    this.chunks = []; // { id, file, page, text, vec: Float32Array, norm }
    this.files = [];  // { file, hash, pages, chunks, bytes }
    this.status = 'idle';
    this.error = null;
    this.building = null;
  }

  async build() {
    if (this.building) return this.building;
    this.building = this._build().finally(() => { this.building = null; });
    return this.building;
  }

  async _build() {
    this.status = 'indexing';
    this.error = null;
    try {
      await fs.mkdir(this.materialsDir, { recursive: true });
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });

      let cache = { model: this.embedModel, files: {} };
      try {
        const raw = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
        if (raw.model === this.embedModel) cache = raw;
      } catch { /* no cache yet */ }

      const entries = await listFiles(this.materialsDir);
      const nextCache = { model: this.embedModel, files: {} };
      const chunks = [];
      const files = [];

      for (const abs of entries) {
        const rel = path.relative(this.materialsDir, abs);
        const buf = await fs.readFile(abs);
        const hash = crypto.createHash('sha1').update(buf).digest('hex');

        let entry = cache.files[rel];
        if (!entry || entry.hash !== hash) {
          let pages;
          try { pages = await extractPages(abs, buf); }
          catch (err) { console.warn(`[index:${this.courseId}] skipped ${rel}: ${err.message}`); continue; }
          const pieces = chunkPages(pages);
          const vectors = await this._embed(pieces.map(p => `${rel}\n${p.text}`));
          entry = {
            hash,
            pages: pages.length,
            bytes: buf.length,
            chunks: pieces.map((p, i) => ({ page: p.page, text: p.text, vec: vectors[i] })),
          };
        }
        nextCache.files[rel] = entry;
        files.push({ file: rel, hash, pages: entry.pages, chunks: entry.chunks.length, bytes: entry.bytes });
        entry.chunks.forEach((c, i) => {
          const vec = Float32Array.from(c.vec);
          chunks.push({ id: `${rel}#${i}`, file: rel, page: c.page, text: c.text, vec, norm: norm(vec) });
        });
      }

      await fs.writeFile(this.cacheFile, JSON.stringify(nextCache));
      this.chunks = chunks;
      this.files = files;
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      console.error(`[index:${this.courseId}]`, err);
    }
    return this.summary();
  }

  async _embed(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = await this.openai.embeddings.create({ model: this.embedModel, input: batch });
      res.data.sort((a, b) => a.index - b.index).forEach(d => out.push(d.embedding));
    }
    return out;
  }

  // Hybrid retrieval: cosine similarity on embeddings plus a small lexical
  // bonus so exact protocol names / acronyms (e.g. "OSPF", "TCP Reno") rank well.
  async search(query, k = 6) {
    if (!this.chunks.length) return [];
    const [qv] = await this._embed([query]);
    const q = Float32Array.from(qv);
    const qn = norm(q);
    const terms = tokenize(query);

    const scored = this.chunks.map(c => {
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * c.vec[i];
      const cos = dot / (qn * c.norm || 1);
      let lex = 0;
      if (terms.length) {
        const lower = c.text.toLowerCase();
        for (const t of terms) if (lower.includes(t)) lex++;
        lex /= terms.length;
      }
      return { c, score: cos + 0.08 * lex };
    });
    scored.sort((a, b) => b.score - a.score);

    // Avoid returning several near-identical neighbours from the same page.
    const picked = [];
    const seen = new Set();
    for (const s of scored) {
      const key = `${s.c.file}:${s.c.page}`;
      if (seen.has(key) && picked.length < k - 1) continue;
      seen.add(key);
      picked.push({ file: s.c.file, page: s.c.page, text: s.c.text, score: +s.score.toFixed(3) });
      if (picked.length >= k) break;
    }
    return picked;
  }

  summary() {
    return {
      status: this.status,
      error: this.error,
      files: this.files,
      chunks: this.chunks.length,
    };
  }
}

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    let items = [];
    try { items = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const abs = path.join(d, it.name);
      if (it.isDirectory()) await walk(abs);
      else if (SUPPORTED.has(path.extname(it.name).toLowerCase())) out.push(abs);
    }
  }
  await walk(dir);
  return out.sort();
}

async function extractPages(abs, buf) {
  const ext = path.extname(abs).toLowerCase();
  if (ext !== '.pdf') return [{ page: null, text: buf.toString('utf8') }];

  const task = getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      text += item.str + (item.hasEOL ? '\n' : ' ');
    }
    pages.push({ page: p, text: text.replace(/[ \t]+/g, ' ').trim() });
  }
  await task.destroy();
  return pages;
}

function chunkPages(pages) {
  const out = [];
  for (const { page, text } of pages) {
    const clean = text.replace(/\n{3,}/g, '\n\n').trim();
    if (clean.length < 40) continue; // skip title-only / blank slides
    if (clean.length <= CHUNK_CHARS) { out.push({ page, text: clean }); continue; }
    let start = 0;
    while (start < clean.length) {
      let end = Math.min(start + CHUNK_CHARS, clean.length);
      if (end < clean.length) {
        const cut = clean.lastIndexOf('\n', end);
        const dot = clean.lastIndexOf('. ', end);
        const best = Math.max(cut, dot);
        if (best > start + CHUNK_CHARS * 0.5) end = best + 1;
      }
      out.push({ page, text: clean.slice(start, end).trim() });
      if (end >= clean.length) break;
      start = end - CHUNK_OVERLAP;
    }
  }
  return out;
}

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

const STOP = new Set(['the', 'and', 'what', 'how', 'why', 'does', 'is', 'are', 'of', 'in', 'to', 'a', 'an', 'for', 'on', 'with', 'nedir', 'nasil', 'bir', 've', 'ile']);
function tokenize(q) {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9çğıöşü.-]+/i).filter(t => t.length > 2 && !STOP.has(t)))];
}
