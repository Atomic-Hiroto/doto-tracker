import axios from 'axios';
import { EmbedBuilder, Message } from 'discord.js';
import { logger } from '../services/loggerService';

const BENCHMARKS_URL = 'https://lmcouncil.ai/benchmarks';
const CACHE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_BENCHMARKS = 3;

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
  domain?: string;
  lastUpdated?: string;
  topModels: LmCouncilModelRow[];
}

interface LmCouncilPayload {
  benchmarks: LmCouncilBenchmark[];
  lastUpdated?: string;
}

interface NormalizedBenchmarkRow {
  benchmark: string;
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
  avgScore: number;
  wins: number;
  top3s: number;
  bestBenchmark: NormalizedBenchmarkRow;
  variants: Set<string>;
}

let cached: { fetchedAt: number; payload: LmCouncilPayload } | null = null;

function parseLimit(args: string[]): number {
  const numeric = args.find((arg) => /^\d+$/.test(arg));
  if (!numeric) return DEFAULT_LIMIT;
  return Math.max(5, Math.min(20, Number(numeric)));
}

function wantsAudit(args: string[]): boolean {
  return args.some((arg) => ['audit', 'debug', 'counts'].includes(arg.toLowerCase()));
}

function wantsAll(args: string[]): boolean {
  return args.some((arg) => ['all', 'full', 'no-min'].includes(arg.toLowerCase()));
}

function parseScore(value: string): number | null {
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const score = Number(match[0]);
  return Number.isFinite(score) ? score : null;
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
      // Ignore non-JSON script fragments; the benchmark payload is in the flight chunks.
    }
  }

  return chunks.join('');
}

function extractJsonObject(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error('LM Council benchmark payload marker not found');

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
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  throw new Error('LM Council benchmark payload was not closed');
}

function parsePayload(html: string): LmCouncilPayload {
  const flight = extractFlightPayload(html);
  const json = extractJsonObject(flight, '{"benchmarks":');
  const payload = JSON.parse(json) as LmCouncilPayload;

  if (!Array.isArray(payload.benchmarks) || payload.benchmarks.length === 0) {
    throw new Error('LM Council benchmark payload had no benchmarks');
  }

  return payload;
}

async function fetchPayload(): Promise<LmCouncilPayload> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.payload;

  const res = await axios.get<string>(BENCHMARKS_URL, {
    timeout: 15000,
    headers: {
      'user-agent': 'Mozilla/5.0 DotoTracker/1.0 (+https://lmcouncil.ai/benchmarks)',
      accept: 'text/html,application/xhtml+xml',
    },
  });

  const payload = parsePayload(res.data);
  cached = { fetchedAt: now, payload };
  return payload;
}

function bestRowsByModel(benchmark: LmCouncilBenchmark): LmCouncilModelRow[] {
  const byModel = new Map<string, LmCouncilModelRow>();

  for (const row of benchmark.topModels) {
    const model = row.normalizedModelName || row.modelName;
    const existing = byModel.get(model);
    if (!existing) {
      byModel.set(model, row);
      continue;
    }

    const score = parseScore(row.accuracy);
    const existingScore = parseScore(existing.accuracy);
    const shouldReplace = score != null && existingScore != null
      ? score > existingScore
      : row.rank < existing.rank;

    if (shouldReplace) byModel.set(model, row);
  }

  return [...byModel.values()];
}

function normalizeBenchmark(benchmark: LmCouncilBenchmark): NormalizedBenchmarkRow[] {
  const rows = bestRowsByModel(benchmark);
  const scores = rows.map((row) => parseScore(row.accuracy)).filter((score): score is number => score != null);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const useScore = scores.length >= 2 && max > min;
  const rankDenom = Math.max(rows.length - 1, 1);

  return rows.map((row, index) => {
    const rawScore = parseScore(row.accuracy);
    const normalizedScore = useScore && rawScore != null
      ? ((rawScore - min) / (max - min)) * 100
      : ((rows.length - 1 - index) / rankDenom) * 100;

    return {
      benchmark: benchmark.name,
      model: row.normalizedModelName || row.modelName,
      variant: row.modelName,
      organization: row.organization || 'Unknown',
      rank: row.rank,
      rawScore,
      normalizedScore,
    };
  });
}

function aggregateBenchmarks(benchmarks: LmCouncilBenchmark[]): ModelAggregate[] {
  const byModel = new Map<string, NormalizedBenchmarkRow[]>();

  for (const benchmark of benchmarks) {
    for (const row of normalizeBenchmark(benchmark)) {
      const existing = byModel.get(row.model) || [];
      existing.push(row);
      byModel.set(row.model, existing);
    }
  }

  return [...byModel.entries()]
    .map(([model, rows]) => {
      const bestBenchmark = [...rows].sort((a, b) => b.normalizedScore - a.normalizedScore)[0];
      const orgCounts = rows.reduce((map, row) => {
        map.set(row.organization, (map.get(row.organization) || 0) + 1);
        return map;
      }, new Map<string, number>());
      const organization = [...orgCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';

      return {
        model,
        organization,
        appearances: rows.length,
        avgScore: rows.reduce((sum, row) => sum + row.normalizedScore, 0) / rows.length,
        wins: rows.filter((row) => row.rank === 1).length,
        top3s: rows.filter((row) => row.rank <= 3).length,
        bestBenchmark,
        variants: new Set(rows.map((row) => row.variant).filter((variant) => variant !== model)),
      };
    })
    .sort((a, b) =>
      b.avgScore - a.avgScore
      || b.appearances - a.appearances
      || b.wins - a.wins
      || a.model.localeCompare(b.model),
    );
}

function formatLine(row: ModelAggregate, index: number): string {
  const variantText = row.variants.size ? ` · best variants: ${[...row.variants].slice(0, 2).join(', ')}` : '';
  return `**${index + 1}. ${row.model}** — ${row.avgScore.toFixed(1)}/100 avg · ${row.appearances} lb · ${row.wins} wins, ${row.top3s} top-3 · ${row.organization}\n` +
    `Best: ${row.bestBenchmark.benchmark} (#${row.bestBenchmark.rank})${variantText}`;
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

function auditLines(payload: LmCouncilPayload): string[] {
  return payload.benchmarks.map((benchmark) => `**${benchmark.name}** — ${benchmark.topModels.length} rows`);
}

export async function topLlms(message: Message, args: string[]) {
  const progress = await message.reply('🧠 Fetching LM Council benchmark leaderboards...');

  try {
    const payload = await fetchPayload();
    const totalRows = payload.benchmarks.reduce((sum, benchmark) => sum + benchmark.topModels.length, 0);

    if (wantsAudit(args)) {
      const embed = new EmbedBuilder()
        .setColor('#22c55e')
        .setTitle('🧠 LM Council Leaderboard Audit')
        .setDescription(`Recovered **${payload.benchmarks.length}** benchmark leaderboards and **${totalRows}** model rows from the page payload.`)
        .addFields({
          name: 'Leaderboards',
          value: fitLines(auditLines(payload), 3900),
          inline: false,
        })
        .setFooter({ text: `Source: lmcouncil.ai/benchmarks • Last updated: ${payload.lastUpdated || 'unknown'}` })
        .setTimestamp();

      await progress.edit({ content: null, embeds: [embed] });
      return;
    }

    const limit = parseLimit(args);
    const minBenchmarks = wantsAll(args) ? 1 : DEFAULT_MIN_BENCHMARKS;
    const aggregates = aggregateBenchmarks(payload.benchmarks)
      .filter((row) => row.appearances >= minBenchmarks)
      .slice(0, limit);

    const embed = new EmbedBuilder()
      .setColor('#a855f7')
      .setTitle('🧠 Top LLMs — LM Council Aggregate')
      .setDescription(fitLines(aggregates.map(formatLine), 3900))
      .addFields(
        {
          name: 'Coverage',
          value:
            `Benchmarks: **${payload.benchmarks.length}** | rows parsed: **${totalRows}**\n` +
            `Minimum coverage: **${minBenchmarks}** leaderboard${minBenchmarks === 1 ? '' : 's'}${minBenchmarks > 1 ? ' (`+topllms all` includes one-offs)' : ''}`,
          inline: false,
        },
        {
          name: 'Method',
          value:
            'For each benchmark leaderboard, scores are normalized from 0-100 within that leaderboard, because the page mixes %, minutes, arena ratings and point scores. ' +
            'Variants are grouped by LM Council normalized model name, using each model family\'s best variant per benchmark, then averaged across benchmark appearances.',
          inline: false,
        },
      )
      .setFooter({ text: `Source: lmcouncil.ai/benchmarks • Last updated: ${payload.lastUpdated || 'unknown'}` })
      .setTimestamp();

    await progress.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in topllms command:', error);
    await progress.edit('Failed to fetch or parse LM Council benchmarks. The page format may have changed; try `+topllms audit` later.');
  }
}
