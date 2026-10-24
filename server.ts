// Linjer — a small line workbench. Bun-only, zero deps.
// Upload .txt/.csv collections, search (substring / wildcard / regex), export matches.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const ROOT = import.meta.dir;
const DATA_DIR = join(ROOT, "data");
const EXPORT_DIR = join(ROOT, "exports");
const CONFIG_PATH = join(ROOT, "config.json");
const META_PATH = join(DATA_DIR, "_meta.json");
const STATE_PATH = join(DATA_DIR, "_state.json");
const CHATGPT_CACHE_PATH = join(DATA_DIR, "_chatgpt_cache.json");
const CHATGPT_ARCHIVE_DIR = process.env.CHATGPT_ARCHIVE_DIR || join(ROOT, "chatgpt-archive-lite");

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB per file
const SEARCH_CAP = 1000; // max matches returned to the UI (export is uncapped)

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(EXPORT_DIR, { recursive: true });

// ---------- config ----------
if (!existsSync(CONFIG_PATH)) {
  writeFileSync(CONFIG_PATH, JSON.stringify({ port: 8787 }, null, 2));
  console.log("Generated config.json");
}
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { port: number };

// ---------- meta & state ----------
type FileMeta = { name: string; bytes: number; lines: number; added: string };
type Collection = { created: string; files: FileMeta[] };
type Meta = { collections: Record<string, Collection> };
type HistoryEntry = { q: string; mode: string; scope: string; count: number; at: string };
type ExportEntry = { name: string; count: number; at: string };
type State = { history: HistoryEntry[]; exports: ExportEntry[] };
type ChatMeta = {
  title?: string;
  conversation_id?: string;
  created?: string | null;
  updated?: string | null;
  messages_written?: number;
  content_types?: Record<string, number>;
};
type ChatEntry = {
  id: string;
  title: string;
  created: string | null;
  updated: string | null;
  year: string;
  bytes: number;
  messages: number;
  thoughts: number;
  reasoningRecaps: number;
  markdownPath: string;
  content: string;
  titleLower: string;
  contentLower: string;
};

function loadMeta(): Meta {
  try { return JSON.parse(readFileSync(META_PATH, "utf8")); } catch { return { collections: {} }; }
}
function saveMeta(m: Meta) { writeFileSync(META_PATH, JSON.stringify(m, null, 2)); }
function loadState(): State {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { history: [], exports: [] }; }
}
function saveState(s: State) { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

// ---------- helpers ----------
function safeName(n: string): string {
  return basename(n).replace(/[\\/:*?"<>|]/g, "_").trim() || "unnamed";
}
function decodeBytes(buf: Uint8Array): string {
  const t = new TextDecoder("utf-8").decode(buf);
  return t.includes("\uFFFD") ? new TextDecoder("windows-1252").decode(buf) : t;
}
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------- ChatGPT archive index ----------
let chatIndex: ChatEntry[] | null = null;

function loadChatIndex(): ChatEntry[] {
  if (chatIndex) return chatIndex;
  if (!existsSync(CHATGPT_ARCHIVE_DIR)) {
    chatIndex = [];
    return chatIndex;
  }

  const summaryPath = join(CHATGPT_ARCHIVE_DIR, "summary.json");
  const sourceStamp = existsSync(summaryPath) ? statSync(summaryPath).mtimeMs : 0;
  if (existsSync(CHATGPT_CACHE_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(CHATGPT_CACHE_PATH, "utf8")) as {
        version: number;
        sourceStamp: number;
        entries: Omit<ChatEntry, "titleLower" | "contentLower">[];
      };
      if (cached.version === 1 && cached.sourceStamp === sourceStamp) {
        chatIndex = cached.entries.map((entry) => ({
          ...entry,
          titleLower: entry.title.toLowerCase(),
          contentLower: entry.content.toLowerCase(),
        }));
        console.log(`Loaded ${chatIndex.length} ChatGPT conversations from cache`);
        return chatIndex;
      }
    } catch (error) {
      console.warn("Rebuilding ChatGPT cache:", (error as Error).message);
    }
  }

  const entries: ChatEntry[] = [];
  for (const dirent of readdirSync(CHATGPT_ARCHIVE_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const folder = dirent.name;
    const folderPath = join(CHATGPT_ARCHIVE_DIR, folder);
    const markdownPath = join(folderPath, "conversation.md");
    const metadataPath = join(folderPath, "metadata.json");
    if (!existsSync(markdownPath) || !existsSync(metadataPath)) continue;
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as ChatMeta;
      const content = readFileSync(markdownPath, "utf8");
      const title = String(metadata.title || folder);
      const created = metadata.created ? String(metadata.created) : null;
      const folderYear = folder.match(/^(\d{4})-/)?.[1];
      const year = created?.match(/^(\d{4})/)?.[1] || (folderYear && folderYear !== "0000" ? folderYear : "Unknown");
      entries.push({
        id: folder,
        title,
        created,
        updated: metadata.updated ? String(metadata.updated) : null,
        year,
        bytes: statSync(markdownPath).size,
        messages: Number(metadata.messages_written || 0),
        thoughts: Number(metadata.content_types?.thoughts || 0),
        reasoningRecaps: Number(metadata.content_types?.reasoning_recap || 0),
        markdownPath,
        content,
        titleLower: title.toLowerCase(),
        contentLower: content.toLowerCase(),
      });
    } catch (error) {
      console.warn(`Skipping ChatGPT archive folder ${folder}:`, (error as Error).message);
    }
  }
  chatIndex = entries;
  writeFileSync(CHATGPT_CACHE_PATH, JSON.stringify({
    version: 1,
    sourceStamp,
    entries: entries.map(({ titleLower, contentLower, ...entry }) => entry),
  }));
  console.log(`Indexed ${entries.length} ChatGPT conversations from ${CHATGPT_ARCHIVE_DIR}`);
  return entries;
}

function lengthBucket(messages: number): string {
  if (messages < 20) return "short";
  if (messages < 100) return "medium";
  if (messages < 300) return "long";
  return "epic";
}

function chatSnippet(entry: ChatEntry, terms: string[]): string {
  const plain = entry.content
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  const lower = plain.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const hit = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, hit - 90);
  const end = Math.min(plain.length, start + 280);
  return (start ? "…" : "") + plain.slice(start, end) + (end < plain.length ? "…" : "");
}

// ---------- line cache (lazy, per collection -> per file) ----------
type ColLines = Map<string, string[]>;
const cache = new Map<string, ColLines>();

async function getColLines(name: string): Promise<ColLines> {
  let col = cache.get(name);
  if (col) return col;
  col = new Map();
  const meta = loadMeta().collections[name];
  for (const f of meta?.files ?? []) {
    const p = join(DATA_DIR, name, f.name);
    if (!existsSync(p)) continue;
    const buf = new Uint8Array(await Bun.file(p).arrayBuffer());
    col.set(f.name, splitLines(decodeBytes(buf)));
  }
  cache.set(name, col);
  return col;
}

// ---------- search ----------
function globToRegex(glob: string): string {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

function buildMatcher(q: string, mode: string, cs: boolean): (s: string) => boolean {
  if (mode === "regex") {
    const m = q.match(/^\/(.*)\/([gimsuy]*)$/s);
    let re: RegExp;
    try {
      re = m ? new RegExp(m[1], m[2].replace(/g/g, "")) : new RegExp(q, cs ? "" : "i");
    } catch (e) {
      throw new Error("Invalid regex: " + (e as Error).message);
    }
    return (s) => re.test(s);
  }
  if (mode === "wildcard") {
    const re = new RegExp(globToRegex(q), cs ? "" : "i");
    return (s) => re.test(s);
  }
  // substring: space-separated terms, all must match
  const terms = q.split(/\s+/).filter(Boolean);
  return (s) => {
    const hay = cs ? s : s.toLowerCase();
    return terms.every((t) => hay.includes(cs ? t : t.toLowerCase()));
  };
}

type Match = { collection: string; file: string; line: number; text: string };

async function runSearch(
  scope: string,
  matcher: (s: string) => boolean,
  cap: number | null,
): Promise<{ total: number; matches: Match[] }> {
  const meta = loadMeta();
  const names = scope === "all" ? Object.keys(meta.collections) : [scope];
  const matches: Match[] = [];
  let total = 0;
  for (const name of names) {
    if (!meta.collections[name]) continue;
    const col = await getColLines(name);
    for (const [fname, lines] of col) {
      for (let i = 0; i < lines.length; i++) {
        if (matcher(lines[i])) {
          total++;
          if (cap === null || matches.length < cap) {
            matches.push({ collection: name, file: fname, line: i + 1, text: lines[i] });
          }
        }
      }
    }
  }
  return { total, matches };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- server ----------
Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  maxRequestBodySize: 2 * 1024 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file(join(ROOT, "index.html")));
    }

    // no auth — private network, owner's explicit call

    try {
      // --- state ---
      if (path === "/api/state" && req.method === "GET") {
        return json({ ...loadState(), meta: loadMeta() });
      }

      // --- ChatGPT archive ---
      if (path === "/api/chatgpt" && req.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        const searchMode = url.searchParams.get("searchMode") || "all-words";
        const searchIn = url.searchParams.get("searchIn") || "all";
        const year = url.searchParams.get("year") || "all";
        const length = url.searchParams.get("length") || "all";
        const reasoning = url.searchParams.get("reasoning") === "1";
        const sort = url.searchParams.get("sort") || "newest";
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        const limit = Math.min(250, Math.max(1, Number(url.searchParams.get("limit") || 100)));
        const terms = q.split(/\s+/).filter(Boolean);

        const all = loadChatIndex();
        let filtered = all.filter((entry) => {
          if (year !== "all" && entry.year !== year) return false;
          if (length !== "all" && lengthBucket(entry.messages) !== length) return false;
          if (reasoning && entry.thoughts + entry.reasoningRecaps === 0) return false;
          if (!q) return true;
          const haystack = searchIn === "title"
            ? entry.titleLower
            : searchIn === "content"
              ? entry.contentLower
              : entry.titleLower + "\n" + entry.contentLower;
          return searchMode === "phrase"
            ? haystack.includes(q)
            : terms.every((term) => haystack.includes(term));
        });

        filtered.sort((a, b) => {
          if (sort === "oldest") return String(a.created || "9999").localeCompare(String(b.created || "9999"));
          if (sort === "title") return a.title.localeCompare(b.title);
          if (sort === "longest") return b.messages - a.messages || b.bytes - a.bytes;
          if (sort === "shortest") return a.messages - b.messages || a.bytes - b.bytes;
          return String(b.created || "").localeCompare(String(a.created || ""));
        });

        const years = [...new Set(all.map((entry) => entry.year))]
          .sort((a, b) => b.localeCompare(a));
        const page = filtered.slice(offset, offset + limit).map((entry) => ({
          id: entry.id,
          title: entry.title,
          created: entry.created,
          updated: entry.updated,
          year: entry.year,
          bytes: entry.bytes,
          messages: entry.messages,
          length: lengthBucket(entry.messages),
          thoughts: entry.thoughts,
          reasoningRecaps: entry.reasoningRecaps,
          snippet: chatSnippet(entry, searchMode === "phrase" && q ? [q] : terms),
        }));
        return json({
          archiveAvailable: existsSync(CHATGPT_ARCHIVE_DIR),
          archivePath: CHATGPT_ARCHIVE_DIR,
          total: filtered.length,
          offset,
          limit,
          hasMore: offset + page.length < filtered.length,
          years,
          stats: {
            conversations: all.length,
            bytes: all.reduce((sum, entry) => sum + entry.bytes, 0),
            withReasoning: all.filter((entry) => entry.thoughts + entry.reasoningRecaps > 0).length,
          },
          items: page,
        });
      }

      if (path.startsWith("/api/chatgpt/download/") && req.method === "GET") {
        const id = decodeURIComponent(path.slice("/api/chatgpt/download/".length));
        const entry = loadChatIndex().find((item) => item.id === id);
        if (!entry) return json({ error: "No such conversation" }, 404);
        const filename = safeName(entry.id) + ".md";
        return new Response(Bun.file(entry.markdownPath), {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          },
        });
      }

      // --- collections ---
      if (path === "/api/collections" && req.method === "POST") {
        const { name } = await req.json();
        const n = safeName(String(name ?? ""));
        const meta = loadMeta();
        if (meta.collections[n]) return json({ error: "Collection already exists" }, 400);
        mkdirSync(join(DATA_DIR, n), { recursive: true });
        meta.collections[n] = { created: new Date().toISOString(), files: [] };
        saveMeta(meta);
        return json({ ok: true, name: n });
      }

      if (path.startsWith("/api/collections/") && req.method === "DELETE") {
        const n = safeName(decodeURIComponent(path.slice("/api/collections/".length)));
        const meta = loadMeta();
        if (!meta.collections[n]) return json({ error: "No such collection" }, 404);
        delete meta.collections[n];
        saveMeta(meta);
        cache.delete(n);
        rmSync(join(DATA_DIR, n), { recursive: true, force: true });
        return json({ ok: true });
      }

      // --- upload ---
      if (path === "/api/upload" && req.method === "POST") {
        const form = await req.formData();
        const collection = safeName(String(form.get("collection") ?? ""));
        const meta = loadMeta();
        if (!meta.collections[collection]) return json({ error: "No such collection" }, 400);
        const files = form.getAll("files").filter((f): f is File => f instanceof File);
        const added: FileMeta[] = [];
        const skipped: { name: string; reason: string }[] = [];
        for (const f of files) {
          if (f.size > MAX_UPLOAD_BYTES) {
            skipped.push({ name: f.name, reason: `over ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB limit` });
            continue;
          }
          const name = safeName(f.name);
          const buf = new Uint8Array(await f.arrayBuffer());
          await Bun.write(join(DATA_DIR, collection, name), buf);
          const lines = splitLines(decodeBytes(buf)).length;
          const rec: FileMeta = { name, bytes: f.size, lines, added: new Date().toISOString() };
          const idx = meta.collections[collection].files.findIndex((x) => x.name === name);
          if (idx >= 0) meta.collections[collection].files[idx] = rec;
          else meta.collections[collection].files.push(rec);
          added.push(rec);
        }
        saveMeta(meta);
        cache.delete(collection);
        return json({ ok: true, added, skipped });
      }

      // --- delete file ---
      if (path === "/api/delete-file" && req.method === "POST") {
        const { collection, file } = await req.json();
        const c = safeName(String(collection ?? ""));
        const f = safeName(String(file ?? ""));
        const meta = loadMeta();
        const col = meta.collections[c];
        if (!col) return json({ error: "No such collection" }, 404);
        col.files = col.files.filter((x) => x.name !== f);
        saveMeta(meta);
        cache.delete(c);
        rmSync(join(DATA_DIR, c, f), { force: true });
        return json({ ok: true });
      }

      // --- search ---
      if (path === "/api/search" && req.method === "POST") {
        const { scope, query, mode, caseSensitive } = await req.json();
        const matcher = buildMatcher(String(query ?? ""), String(mode ?? "substring"), !!caseSensitive);
        const { total, matches } = await runSearch(String(scope ?? "all"), matcher, SEARCH_CAP);
        const st = loadState();
        st.history = [
          { q: String(query ?? ""), mode: String(mode ?? "substring"), scope: String(scope ?? "all"), count: total, at: new Date().toISOString() },
          ...st.history.filter((h) => !(h.q === String(query ?? "") && h.mode === String(mode ?? "") && h.scope === String(scope ?? ""))),
        ].slice(0, 25);
        saveState(st);
        return json({ total, capped: total > SEARCH_CAP, matches });
      }

      // --- export ---
      if (path === "/api/export" && req.method === "POST") {
        const { scope, query, mode, caseSensitive, name } = await req.json();
        const matcher = buildMatcher(String(query ?? ""), String(mode ?? "substring"), !!caseSensitive);
        const { total, matches } = await runSearch(String(scope ?? "all"), matcher, null);
        const content = matches.map((m) => m.text).join("\n") + (matches.length ? "\n" : "");
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        const base = safeName(String(name ?? "")) !== "unnamed"
          ? safeName(String(name ?? ""))
          : `${String(scope ?? "all")}-${stamp}`;
        const fname = base.endsWith(".txt") ? base : base + ".txt";
        writeFileSync(join(EXPORT_DIR, fname), content, "utf8");
        const st = loadState();
        st.exports = [{ name: fname, count: total, at: new Date().toISOString() }, ...st.exports].slice(0, 25);
        saveState(st);
        return new Response(content, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
            "X-Export-Path": join(EXPORT_DIR, fname),
          },
        });
      }

      // --- re-download a past export ---
      if (path.startsWith("/api/exports/") && req.method === "GET") {
        const fname = safeName(decodeURIComponent(path.slice("/api/exports/".length)));
        const p = join(EXPORT_DIR, fname);
        if (!existsSync(p)) return json({ error: "No such export" }, 404);
        return new Response(Bun.file(p), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
          },
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  },
});

console.log(`Linjer running on http://0.0.0.0:${config.port}`);
