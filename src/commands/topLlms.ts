import axios from 'axios';
import { EmbedBuilder, Message } from 'discord.js';
import { logger } from '../services/loggerService';

const CACHE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_BENCHMARKS = 3;
// Bayesian shrinkage weight: a model needs ~this many leaderboards before its own
// average outweighs the field prior. Stops narrowly-tested models (measured on a
// few favorable big-field boards) from outranking broadly-tested ones.
const SHRINKAGE_K = 5;

const SOURCES = {
  lmCouncil: 'https://lmcouncil.ai/benchmarks',
  arenaText: 'https://arena.ai/leaderboard/text',
  artificialAnalysis: 'https://artificialanalysis.ai/leaderboards/models',
  liveBench: 'https://livebench.ai/#/?highunseenbias=true',
  eqBenchCreativeWriting: 'https://eqbench.com/creative_writing.html',
};

interface RawBenchmarkRow {
  model: string;
  variant: string;
  organization: string;
  rank: number;
  score: number | null;
}

interface BenchmarkTable {
  id: string;
  name: string;
  source: string;
  url: string;
  lastUpdated?: string;
  rows: RawBenchmarkRow[];
  rawRows: number;
}

interface SourceStatus {
  source: string;
  ok: boolean;
  tables: number;
  rows: number;
  detail?: string;
}

interface LoadedBenchmarks {
  fetchedAt: number;
  tables: BenchmarkTable[];
  statuses: SourceStatus[];
}

interface NormalizedBenchmarkRow {
  benchmark: string;
  source: string;
  model: string;
  variant: string;
  organization: string;
  rank: number;
  rawScore: number | null;
  normalizedScore: number;
}

interface ModelAggregate {
  model: string;
  organization: string;
  appearances: number;
  sourceCount: number;
  avgScore: number;
  rawAvgScore: number;
  wins: number;
  top3s: number;
  bestBenchmark: NormalizedBenchmarkRow;
  variants: Set<string>;
}

interface LmCouncilModelRow {
  rank: number;
  modelName: string;
  normalizedModelName?: string;
  accuracy: string;
  organization?: string;
}

interface LmCouncilBenchmark {
  id: string;
  name: string;
  lastUpdated?: string;
  sourceUrl?: string;
  topModels: LmCouncilModelRow[];
}

interface LmCouncilPayload {
  benchmarks: LmCouncilBenchmark[];
  lastUpdated?: string;
}

interface ArenaEntry {
  rank: number;
  modelKey: string;
  modelDisplayName: string;
  rating: number;
  modelOrganization?: string;
}

interface ArtificialAnalysisModel {
  name: string;
  shortName?: string;
  slug: string;
  deprecated?: boolean;
  modelCreatorName?: string;
  intelligenceIndex?: number;
}

type LoaderResult =
  | { loader: { source: string; load: () => Promise<BenchmarkTable[]> }; ok: true; tables: BenchmarkTable[] }
  | { loader: { source: string; load: () => Promise<BenchmarkTable[]> }; ok: false; error: unknown };

let cached: LoadedBenchmarks | null = null;

function parseLimit(args: string[]): number {
  const numeric = args.find((arg) => /^\d+$/.test(arg));
  if (!numeric) return DEFAULT_LIMIT;
  return Math.max(5, Math.min(20, Number(numeric)));
}

function wantsAudit(args: string[]): boolean {
  return args.some((arg) => ['audit', 'debug', 'counts', 'sources'].includes(arg.toLowerCase()));
}

function wantsAll(args: string[]): boolean {
  return args.some((arg) => ['all', 'full', 'no-min'].includes(arg.toLowerCase()));
}

function wantsLmCouncilOnly(args: string[]): boolean {
  return args.some((arg) => ['lm', 'lmcouncil', 'lm-only', 'legacy'].includes(arg.toLowerCase()));
}

function parseScore(value: string): number | null {
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const score = Number(match[0]);
  return Number.isFinite(score) ? score : null;
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

async function fetchText(url: string): Promise<string> {
  const res = await axios.get<string>(url, {
    timeout: 20000,
    responseType: 'text',
    transformResponse: [(data) => data],
    headers: {
      'user-agent': 'Mozilla/5.0 DotoTracker/1.0',
      accept: 'text/html,application/xhtml+xml,text/plain,*/*',
    },
  });
  return res.data;
}

function extractFlightPayload(html: string): string {
  const chunks: string[] = [];
  const re = /self\.__next_f\.push\((.*?)\)<\/script>/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(html))) {
    try {
      const parsed = JSON.parse(match[1]);
      if (typeof parsed?.[1] === 'string') chunks.push(parsed[1]);
    } catch {
      // Ignore non-JSON script fragments.
    }
  }

  return chunks.join('');
}

function extractJsonObjectAt(text: string, start: number): string {
  const objectStart = text.indexOf('{', start);
  if (objectStart < 0) throw new Error('JSON object start not found');
  return extractBalanced(text, objectStart, '{', '}');
}

function extractJsonArrayAt(text: string, start: number): string {
  const arrayStart = text.indexOf('[', start);
  if (arrayStart < 0) throw new Error('JSON array start not found');
  return extractBalanced(text, arrayStart, '[', ']');
}

function extractBalanced(text: string, start: number, open: string, close: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  throw new Error('Balanced JSON fragment was not closed');
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows.filter((r) => r.some((cellValue) => cellValue.trim().length > 0));
}

function rowsToObjects(rows: string[][]): Record<string, string>[] {
  const [headers, ...body] = rows;
  return body.map((row) => {
    const out: Record<string, string> = {};
    headers.forEach((header, index) => {
      out[header] = row[index] ?? '';
    });
    return out;
  });
}

function assertMinRows(table: BenchmarkTable, minRows: number) {
  if (table.rows.length < minRows) {
    throw new Error(`${table.name} parsed only ${table.rows.length} rows`);
  }
}

function average(values: number[]): number | null {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function canonicalModelName(rawName: string): string {
  const withoutPrefix = htmlDecode(rawName)
    .replace(/^\*/, '')
    .replace(/^[a-z0-9_.-]+\//i, '')
    .trim();
  const lower = withoutPrefix.toLowerCase();

  const known: Array<[RegExp, string]> = [
    [/claude[- ]?fable[- ]?5|claude fable 5/, 'Claude Fable 5'],
    [/claude.*opus.*4[ .-]?8|claude[- ]?opus[- ]?4[-.]?8/, 'Claude Opus 4.8'],
    [/claude.*opus.*4[ .-]?7|claude[- ]?opus[- ]?4[-.]?7/, 'Claude Opus 4.7'],
    [/claude.*opus.*4[ .-]?6|claude[- ]?opus[- ]?4[-.]?6/, 'Claude Opus 4.6'],
    [/claude.*opus.*4[ .-]?5|claude[- ]?opus[- ]?4[-.]?5/, 'Claude Opus 4.5'],
    [/claude.*opus.*4[ .-]?1|claude[- ]?4[-.]?1[- ]?opus/, 'Claude Opus 4.1'],
    [/claude.*sonnet.*5|claude[- ]?sonnet[- ]?5/, 'Claude Sonnet 5'],
    [/claude.*sonnet.*4[ .-]?6|claude[- ]?sonnet[- ]?4[-.]?6/, 'Claude Sonnet 4.6'],
    [/claude.*sonnet.*4[ .-]?5|claude[- ]?4[-.]?5[- ]?sonnet|claude[- ]?sonnet[- ]?4[-.]?5/, 'Claude Sonnet 4.5'],
    [/claude.*sonnet.*4\b|claude[- ]?4[- ]?sonnet|claude[- ]?sonnet[- ]?4\b/, 'Claude Sonnet 4'],
    [/claude.*3[ .-]?7.*sonnet|claude[- ]?3[-.]?7[- ]?sonnet/, 'Claude 3.7 Sonnet'],
    [/gpt[- ]?5[.]5[- ]?pro/, 'GPT-5.5 Pro'],
    [/gpt[- ]?5[.]5/, 'GPT-5.5'],
    [/gpt[- ]?5[.]4[- ]?pro/, 'GPT-5.4 Pro'],
    [/gpt[- ]?5[.]4[- ]?mini/, 'GPT-5.4 Mini'],
    [/gpt[- ]?5[.]4/, 'GPT-5.4'],
    [/gpt[- ]?5[.]3[- ]?codex/, 'GPT-5.3 Codex'],
    [/gpt[- ]?5[.]3/, 'GPT-5.3'],
    [/gpt[- ]?5[.]2[- ]?pro/, 'GPT-5.2 Pro'],
    [/gpt[- ]?5[.]2[- ]?codex/, 'GPT-5.2 Codex'],
    [/gpt[- ]?5[.]2/, 'GPT-5.2'],
    [/gpt[- ]?5[.]1[- ]?codex[- ]?max/, 'GPT-5.1-Codex-Max'],
    [/gpt[- ]?5[.]1[- ]?codex/, 'GPT-5.1 Codex'],
    [/gpt[- ]?5[.]1/, 'GPT-5.1'],
    [/gpt[- ]?5\b/, 'GPT-5'],
    [/gpt[- ]?4o/, 'GPT-4o'],
    [/o3[- ]?mini/, 'o3-mini'],
    [/^o3\b|^o3[ -]/, 'o3'],
    [/o4[- ]?mini/, 'o4-mini'],
    [/gemini[- ]?3[.]5[- ]?flash/, 'Gemini 3.5 Flash'],
    [/gemini[- ]?3[.]1[- ]?pro/, 'Gemini 3.1 Pro'],
    [/gemini[- ]?3[.]1[- ]?flash/, 'Gemini 3.1 Flash'],
    [/gemini[- ]?3[- ]?pro/, 'Gemini 3 Pro Preview'],
    [/gemini[- ]?3[- ]?flash/, 'Gemini 3 Flash Preview'],
    [/gemini[- ]?2[.]5[- ]?pro/, 'Gemini 2.5 Pro'],
    [/gemini[- ]?2[.]5[- ]?flash/, 'Gemini 2.5 Flash'],
    [/grok[- ]?4[.]3/, 'Grok 4.3'],
    [/grok[- ]?4[.]20/, 'Grok 4.20 Beta'],
    [/grok[- ]?4[.]1/, 'Grok 4.1'],
    [/grok[- ]?4\b/, 'Grok 4'],
    [/glm[- ]?5[.]2/, 'GLM 5.2'],
    [/glm[- ]?5[.]1/, 'GLM 5.1'],
    [/glm[- ]?5\b/, 'GLM 5'],
    [/glm[- ]?4[.]7/, 'GLM 4.7'],
    [/kimi[- ]?k2[.]6/, 'Kimi K2.6'],
    [/kimi[- ]?k2[.]5/, 'Kimi K2.5'],
    [/kimi[- ]?k2\b/, 'Kimi K2'],
    [/deepseek.*v?4.*pro/, 'DeepSeek V4 Pro'],
    [/deepseek.*3[.]2.*speciale/, 'DeepSeek 3.2 Speciale'],
    [/deepseek.*3[.]2/, 'DeepSeek 3.2'],
    [/qwen.*3[.]7.*max/, 'Qwen 3.7 Max'],
    [/qwen.*3[.]6.*max/, 'Qwen 3.6 Max'],
    [/qwen.*3[.]5/, 'Qwen 3.5'],
    [/qwen.*3\b/, 'Qwen 3'],
    [/muse[- ]?spark/, 'Muse Spark'],
    [/horizon[- ]?beta/, 'Horizon Beta'],
    [/horizon[- ]?alpha/, 'Horizon Alpha'],
  ];

  for (const [pattern, canonical] of known) {
    if (pattern.test(lower)) return canonical;
  }

  return withoutPrefix
    .replace(/\s*\((?:adaptive reasoning|reasoning|non-reasoning|thinking|max effort|max|xhigh|high|medium|low|minimal|base|preview|with fallback)[^)]*\)\s*$/i, '')
    .replace(/[-_\s]+(?:xhigh|high|medium|low|minimal|thinking|base)$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchLmCouncilTables(): Promise<BenchmarkTable[]> {
  const html = await fetchText(SOURCES.lmCouncil);
  const flight = extractFlightPayload(html);
  const marker = '{"benchmarks":';
  const start = flight.indexOf(marker);
  if (start < 0) throw new Error('LM Council payload marker not found');

  const payload = JSON.parse(extractJsonObjectAt(flight, start)) as LmCouncilPayload;
  if (!Array.isArray(payload.benchmarks)) throw new Error('LM Council benchmarks missing');

  const tables = payload.benchmarks.map((benchmark) => ({
    id: `lmcouncil:${benchmark.id}`,
    name: benchmark.name,
    source: 'LM Council',
    url: benchmark.sourceUrl || SOURCES.lmCouncil,
    lastUpdated: benchmark.lastUpdated || payload.lastUpdated,
    rawRows: benchmark.topModels.length,
    rows: benchmark.topModels.map((row) => ({
      model: row.normalizedModelName || row.modelName,
      variant: row.modelName,
      organization: row.organization || 'Unknown',
      rank: row.rank,
      score: parseScore(row.accuracy),
    })),
  }));

  if (tables.length < 10) throw new Error(`LM Council parsed only ${tables.length} benchmark tables`);
  tables.forEach((table) => assertMinRows(table, 5));
  return tables;
}

async function fetchArenaTextTable(): Promise<BenchmarkTable[]> {
  const html = await fetchText(SOURCES.arenaText);
  const flight = extractFlightPayload(html);
  const marker = '"leaderboard":{"arenaSlug":"text"';
  const start = flight.indexOf(marker);
  if (start < 0) throw new Error('Arena text leaderboard marker not found');

  const leaderboard = JSON.parse(extractJsonObjectAt(flight, start)) as {
    entries: ArenaEntry[];
    voteCutoffISOString?: string;
  };

  const table: BenchmarkTable = {
    id: 'arena:text-overall',
    name: 'Arena Text Overall',
    source: 'Arena',
    url: SOURCES.arenaText,
    lastUpdated: leaderboard.voteCutoffISOString,
    rawRows: leaderboard.entries.length,
    rows: leaderboard.entries.map((entry) => ({
      model: entry.modelDisplayName,
      variant: entry.modelKey || entry.modelDisplayName,
      organization: entry.modelOrganization || 'Unknown',
      rank: entry.rank,
      score: Number.isFinite(entry.rating) ? entry.rating : null,
    })),
  };

  assertMinRows(table, 100);
  return [table];
}

async function fetchArtificialAnalysisTable(): Promise<BenchmarkTable[]> {
  const html = await fetchText(SOURCES.artificialAnalysis);
  const flight = extractFlightPayload(html);
  const metricIndex = flight.indexOf('"intelligenceIndex":');
  if (metricIndex < 0) throw new Error('Artificial Analysis intelligenceIndex missing');

  const modelsProp = flight.lastIndexOf('"models":[', metricIndex);
  if (modelsProp < 0) throw new Error('Artificial Analysis models array missing');

  const models = JSON.parse(extractJsonArrayAt(flight, modelsProp)) as ArtificialAnalysisModel[];
  const ranked = models
    .filter((model) => !model.deprecated && typeof model.intelligenceIndex === 'number' && Number.isFinite(model.intelligenceIndex))
    .sort((a, b) => (b.intelligenceIndex ?? 0) - (a.intelligenceIndex ?? 0));

  const table: BenchmarkTable = {
    id: 'artificial-analysis:intelligence-index',
    name: 'Artificial Analysis Intelligence Index',
    source: 'Artificial Analysis',
    url: SOURCES.artificialAnalysis,
    rawRows: ranked.length,
    rows: ranked.map((model, index) => ({
      model: model.shortName || model.name,
      variant: model.name || model.shortName || model.slug,
      organization: model.modelCreatorName || 'Unknown',
      rank: index + 1,
      score: model.intelligenceIndex ?? null,
    })),
  };

  assertMinRows(table, 50);
  return [table];
}

function latestLiveBenchDateFromBundle(js: string): string {
  const sliderIndex = js.indexOf('type:"range"');
  const searchArea = sliderIndex >= 0 ? js.slice(sliderIndex, sliderIndex + 3000) : js;
  const dates = [...searchArea.matchAll(/20\d{2}-\d{2}-\d{2}/g)].map((match) => match[0]);
  const unique = [...new Set(dates)].sort();
  const latest = unique[unique.length - 1];
  if (!latest) throw new Error('LiveBench release dates not found');
  return latest;
}

async function fetchLiveBenchTable(): Promise<BenchmarkTable[]> {
  const html = await fetchText('https://livebench.ai/');
  const scriptMatch = html.match(/src="(\.\/static\/js\/main\.[^"]+\.js)"/);
  if (!scriptMatch) throw new Error('LiveBench main JS script not found');

  const scriptUrl = new URL(scriptMatch[1].replace(/^\.\//, ''), 'https://livebench.ai/').toString();
  const js = await fetchText(scriptUrl);
  const date = latestLiveBenchDateFromBundle(js);
  const slug = date.replace(/-/g, '_');
  const [csv, categoriesText] = await Promise.all([
    fetchText(`https://livebench.ai/table_${slug}.csv`),
    fetchText(`https://livebench.ai/categories_${slug}.json`),
  ]);
  const categories = JSON.parse(categoriesText) as Record<string, string[]>;
  const rows = rowsToObjects(parseCsv(csv));

  const scored = rows
    .map((row) => {
      const categoryScores = Object.values(categories)
        .map((fields) => average(fields.map((field) => Number(row[field]))))
        .filter((value): value is number => value != null);
      return { row, score: average(categoryScores) };
    })
    .filter((entry) => entry.score != null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const table: BenchmarkTable = {
    id: `livebench:${date}`,
    name: `LiveBench Global Average (${date})`,
    source: 'LiveBench',
    url: SOURCES.liveBench,
    lastUpdated: date,
    rawRows: scored.length,
    rows: scored.map((entry, index) => ({
      model: entry.row.model,
      variant: entry.row.model,
      organization: 'Unknown',
      rank: index + 1,
      score: entry.score,
    })),
  };

  assertMinRows(table, 50);
  return [table];
}

async function fetchEqBenchCreativeWritingTable(): Promise<BenchmarkTable[]> {
  const html = await fetchText(SOURCES.eqBenchCreativeWriting);
  const scriptMatch = html.match(/src="(creative_writing\.js\?v=[^"]+)"/);
  if (!scriptMatch) throw new Error('EQ-Bench creative writing JS not found');

  const scriptUrl = new URL(scriptMatch[1], SOURCES.eqBenchCreativeWriting).toString();
  const js = await fetchText(scriptUrl);
  const csvMatch = js.match(/let leaderboardDataCreativeWritingV3 = `([\s\S]*?)`;/);
  if (!csvMatch) throw new Error('EQ-Bench creative writing CSV not found');

  const csvRows = parseCsv(csvMatch[1].trim());
  const header = csvRows[0];
  const metadataIndex = csvRows.findIndex((row) => row[0] === '__metadata__');
  const body = csvRows.slice(1, metadataIndex >= 0 ? metadataIndex : undefined);
  const modelIndex = header.indexOf('model_name');
  const eloIndex = header.indexOf('elo_score');
  if (modelIndex < 0 || eloIndex < 0) throw new Error('EQ-Bench CSV columns missing');

  const parsedRows = body
    .map((row) => ({ model: row[modelIndex], score: Number(row[eloIndex]) }))
    .filter((row) => row.model && Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score);

  const table: BenchmarkTable = {
    id: 'eqbench:creative-writing-v3',
    name: 'EQ-Bench Creative Writing v3',
    source: 'EQ-Bench',
    url: SOURCES.eqBenchCreativeWriting,
    rawRows: parsedRows.length,
    rows: parsedRows.map((row, index) => ({
      model: row.model,
      variant: row.model,
      organization: 'Unknown',
      rank: index + 1,
      score: row.score,
    })),
  };

  assertMinRows(table, 50);
  return [table];
}

async function loadBenchmarks(lmCouncilOnly: boolean): Promise<LoadedBenchmarks> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_MS && !lmCouncilOnly) return cached;

  const loaders: Array<{ source: string; load: () => Promise<BenchmarkTable[]> }> = [
    { source: 'LM Council', load: fetchLmCouncilTables },
  ];

  if (!lmCouncilOnly) {
    loaders.push(
      { source: 'Arena', load: fetchArenaTextTable },
      { source: 'Artificial Analysis', load: fetchArtificialAnalysisTable },
      { source: 'LiveBench', load: fetchLiveBenchTable },
      { source: 'EQ-Bench', load: fetchEqBenchCreativeWritingTable },
    );
  }

  const settled: LoaderResult[] = await Promise.all(loaders.map(async (loader): Promise<LoaderResult> => {
    try {
      const tables = await loader.load();
      return { loader, ok: true, tables };
    } catch (error) {
      return { loader, ok: false, error };
    }
  }));

  const tables: BenchmarkTable[] = [];
  const statuses: SourceStatus[] = [];

  for (const result of settled) {
    if (result.ok) {
      tables.push(...result.tables);
      statuses.push({
        source: result.loader.source,
        ok: true,
        tables: result.tables.length,
        rows: result.tables.reduce((sum, table) => sum + table.rawRows, 0),
      });
    } else {
      statuses.push({
        source: result.loader.source,
        ok: false,
        tables: 0,
        rows: 0,
        detail: result.error instanceof Error ? result.error.message : String(result.error),
      });
    }
  }

  if (!tables.length) throw new Error('No benchmark sources parsed successfully');

  const loaded = { fetchedAt: now, tables, statuses };
  if (!lmCouncilOnly) cached = loaded;
  return loaded;
}

function bestRowsByCanonicalModel(table: BenchmarkTable): NormalizedBenchmarkRow[] {
  const byModel = new Map<string, RawBenchmarkRow & { canonical: string }>();

  for (const row of table.rows) {
    const canonical = canonicalModelName(row.model);
    const existing = byModel.get(canonical);
    if (!existing) {
      byModel.set(canonical, { ...row, canonical });
      continue;
    }

    const shouldReplace = row.score != null && existing.score != null
      ? row.score > existing.score
      : row.rank < existing.rank;

    if (shouldReplace) byModel.set(canonical, { ...row, canonical });
  }

  const rows = [...byModel.values()].sort((a, b) => a.rank - b.rank);
  const scores = rows.map((row) => row.score).filter((score): score is number => score != null);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const useScore = scores.length >= 2 && max > min;
  const rankDenom = Math.max(rows.length - 1, 1);

  return rows.map((row, index) => ({
    benchmark: table.name,
    source: table.source,
    model: row.canonical,
    variant: row.variant,
    organization: row.organization,
    rank: row.rank,
    rawScore: row.score,
    normalizedScore: useScore && row.score != null
      ? ((row.score - min) / (max - min)) * 100
      : ((rows.length - 1 - index) / rankDenom) * 100,
  }));
}

function aggregateBenchmarks(tables: BenchmarkTable[]): ModelAggregate[] {
  const byModel = new Map<string, NormalizedBenchmarkRow[]>();

  for (const table of tables) {
    for (const row of bestRowsByCanonicalModel(table)) {
      const existing = byModel.get(row.model) || [];
      existing.push(row);
      byModel.set(row.model, existing);
    }
  }

  // Field prior: mean normalized position across every tracked appearance. Models
  // measured on few boards are shrunk toward this so low coverage can't be gamed.
  const allRows = [...byModel.values()].flat();
  const prior = allRows.length
    ? allRows.reduce((sum, row) => sum + row.normalizedScore, 0) / allRows.length
    : 0;

  return [...byModel.entries()]
    .map(([model, rows]) => {
      const bestBenchmark = [...rows].sort((a, b) => b.normalizedScore - a.normalizedScore)[0];
      const orgCounts = rows.reduce((map, row) => {
        map.set(row.organization, (map.get(row.organization) || 0) + 1);
        return map;
      }, new Map<string, number>());
      const organization = [...orgCounts.entries()]
        .filter(([org]) => org !== 'Unknown')
        .sort((a, b) => b[1] - a[1])[0]?.[0] || rows[0].organization || 'Unknown';

      const rawAvgScore = rows.reduce((sum, row) => sum + row.normalizedScore, 0) / rows.length;
      const top3s = rows.filter((row) => row.rank <= 3).length;
      // Effective coverage: each top-3 finish counts as extra evidence of skill, so a
      // dominant-but-thinly-tested model resists shrinkage while a mediocre-but-thin one
      // (no top-3s, e.g. best finish #15) still collapses toward the field prior.
      const effectiveCoverage = rows.length + top3s;
      const avgScore = (effectiveCoverage * rawAvgScore + SHRINKAGE_K * prior) / (effectiveCoverage + SHRINKAGE_K);

      return {
        model,
        organization,
        appearances: rows.length,
        sourceCount: new Set(rows.map((row) => row.source)).size,
        avgScore,
        rawAvgScore,
        wins: rows.filter((row) => row.rank === 1).length,
        top3s,
        bestBenchmark,
        variants: new Set(rows.map((row) => row.variant).filter((variant) => canonicalModelName(variant) !== model)),
      };
    })
    .sort((a, b) =>
      b.avgScore - a.avgScore
      || b.appearances - a.appearances
      || b.sourceCount - a.sourceCount
      || b.wins - a.wins
      || a.model.localeCompare(b.model),
    );
}

function formatLine(row: ModelAggregate, index: number): string {
  const variantText = row.variants.size ? ` · variants: ${[...row.variants].slice(0, 2).join(', ')}` : '';
  const shrinkText = Math.abs(row.avgScore - row.rawAvgScore) >= 2 ? ` (raw ${row.rawAvgScore.toFixed(1)})` : '';
  return `**${index + 1}. ${row.model}** — ${row.avgScore.toFixed(1)}/100 avg${shrinkText} · ${row.appearances} lb / ${row.sourceCount} src · ${row.wins} wins, ${row.top3s} top-3 · ${row.organization}\n` +
    `Best: ${row.bestBenchmark.source} / ${row.bestBenchmark.benchmark} (#${row.bestBenchmark.rank})${variantText}`;
}

function fitLines(lines: string[], limit = 3800): string {
  const out: string[] = [];
  let used = 0;

  for (let i = 0; i < lines.length; i++) {
    const extra = lines[i].length + (out.length ? 1 : 0);
    if (used + extra > limit) {
      out.push(`...and ${lines.length - i} more.`);
      break;
    }
    out.push(lines[i]);
    used += extra;
  }

  return out.join('\n');
}

function statusLines(statuses: SourceStatus[]): string[] {
  return statuses.map((status) => {
    if (!status.ok) return `**${status.source}** — failed: ${status.detail || 'unknown error'}`;
    return `**${status.source}** — ${status.tables} leaderboard${status.tables === 1 ? '' : 's'}, ${status.rows} rows`;
  });
}

function tableLines(tables: BenchmarkTable[]): string[] {
  return tables.map((table) => `**${table.source} / ${table.name}** — ${table.rawRows} rows`);
}

export async function topLlms(message: Message, args: string[]) {
  const progress = await message.reply('🧠 Fetching LLM benchmark leaderboards...');

  try {
    const loaded = await loadBenchmarks(wantsLmCouncilOnly(args));
    const totalRows = loaded.tables.reduce((sum, table) => sum + table.rawRows, 0);
    const failed = loaded.statuses.filter((status) => !status.ok);

    if (wantsAudit(args)) {
      const embed = new EmbedBuilder()
        .setColor(failed.length ? '#f59e0b' : '#22c55e')
        .setTitle('🧠 Top LLM Source Audit')
        .setDescription(`Recovered **${loaded.tables.length}** benchmark leaderboards and **${totalRows}** model rows from **${loaded.statuses.filter((s) => s.ok).length}/${loaded.statuses.length}** sources.`)
        .addFields(
          {
            name: 'Source Status',
            value: fitLines(statusLines(loaded.statuses), 1000),
            inline: false,
          },
          {
            name: 'Leaderboards',
            value: fitLines(tableLines(loaded.tables), 1000),
            inline: false,
          },
        )
        .setFooter({ text: 'Sources: LM Council, Arena, Artificial Analysis, LiveBench, EQ-Bench' })
        .setTimestamp();

      await progress.edit({ content: null, embeds: [embed] });
      return;
    }

    const limit = parseLimit(args);
    const minBenchmarks = wantsAll(args) ? 1 : DEFAULT_MIN_BENCHMARKS;
    const aggregates = aggregateBenchmarks(loaded.tables)
      .filter((row) => row.appearances >= minBenchmarks)
      .slice(0, limit);

    const embed = new EmbedBuilder()
      .setColor(failed.length ? '#f59e0b' : '#a855f7')
      .setTitle('🧠 Top LLMs — Multi-Benchmark Aggregate')
      .setDescription(fitLines(aggregates.map(formatLine), 3900))
      .addFields(
        {
          name: 'Coverage',
          value:
            `Leaderboards: **${loaded.tables.length}** | rows parsed: **${totalRows}** | sources ok: **${loaded.statuses.filter((s) => s.ok).length}/${loaded.statuses.length}**\n` +
            `Minimum coverage: **${minBenchmarks}** leaderboard${minBenchmarks === 1 ? '' : 's'}${minBenchmarks > 1 ? ' (`+topllms all` includes one-offs)' : ''}`,
          inline: false,
        },
        {
          name: 'Method',
          value:
            'Each source leaderboard is normalized 0-100 within itself, because raw units differ. ' +
            `Averages are coverage-shrunk toward the field mean (k=${SHRINKAGE_K}) so a model measured on only a few favorable boards cannot outrank broadly-tested ones; proven top-3 finishes count as extra coverage, so a dominant model keeps its rank even without full benchmark coverage. \`(raw X)\` shows the pre-shrink average. ` +
            'Model names are canonicalized conservatively; within each leaderboard, a canonical model gets only its best variant so effort-level variants do not double-count. ' +
            'Use `+topllms audit` to verify source row counts, or `+topllms lm` for LM Council only.',
          inline: false,
        },
      )
      .setFooter({ text: 'Sources: LM Council, Arena, Artificial Analysis, LiveBench, EQ-Bench' })
      .setTimestamp();

    if (failed.length) {
      embed.addFields({
        name: 'Skipped Sources',
        value: fitLines(statusLines(failed), 900),
        inline: false,
      });
    }

    await progress.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in topllms command:', error);
    await progress.edit('Failed to fetch or parse LLM benchmark sources. Try `+topllms audit`; one of the source page formats may have changed.');
  }
}
