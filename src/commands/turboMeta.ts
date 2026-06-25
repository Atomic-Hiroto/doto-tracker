import { EmbedBuilder, Message } from 'discord.js';
import { dotaDataService } from '../services/dotaDataService';
import { logger } from '../services/loggerService';
import { fetchStratzTurboMetaByPosition, TurboMetaPositionHero } from '../services/stratzClient';

// Pos 1..5 display labels.
const POSITION_LABELS: Record<number, string> = {
  1: '🛡️ Pos 1 — Safelane Carry',
  2: '⚔️ Pos 2 — Mid',
  3: '🪓 Pos 3 — Offlane',
  4: '🎯 Pos 4 — Soft Support',
  5: '💉 Pos 5 — Hard Support',
};

const TOP_N = 8;
// Absolute floor so a hero with a handful of games never tops a role.
const MIN_GAMES_FLOOR = 2000;
// Dynamic gate: also require at least this fraction of the role's total games.
const MIN_GAMES_FRACTION = 0.0015;

interface RankedHero {
  heroId: number;
  matchCount: number;
  winRate: number;
  wilson: number;
}

/** Wilson score lower bound of the win rate at 95% confidence. */
function wilsonLowerBound(wins: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (centre - margin) / denom;
}

function rankPosition(rows: TurboMetaPositionHero[]): { ranked: RankedHero[]; gate: number; totalGames: number } {
  const totalGames = rows.reduce((sum, r) => sum + r.matchCount, 0);
  const gate = Math.max(MIN_GAMES_FLOOR, Math.round(totalGames * MIN_GAMES_FRACTION));
  const ranked = rows
    .filter((r) => r.matchCount >= gate)
    .map((r) => ({
      heroId: r.heroId,
      matchCount: r.matchCount,
      winRate: r.winCount / r.matchCount,
      wilson: wilsonLowerBound(r.winCount, r.matchCount),
    }))
    .sort((a, b) => b.wilson - a.wilson);
  return { ranked, gate, totalGames };
}

function fmtGames(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export async function turboMeta(message: Message) {
  const loading = await message.reply('⏳ Pulling the live Turbo meta from STRATZ (per position, last 7 days)…');
  try {
    const byPosition = await fetchStratzTurboMetaByPosition();
    const hasData = Object.values(byPosition).some((rows) => rows && rows.length > 0);
    if (!hasData) {
      return loading.edit('Could not fetch the Turbo meta from STRATZ right now (no data or API key missing). Try again later.');
    }

    // Preload hero names for every hero we might render.
    const heroIds = new Set<number>();
    for (let pos = 1; pos <= 5; pos++) {
      for (const r of (byPosition[pos] ?? [])) heroIds.add(r.heroId);
    }
    const nameMap = new Map<number, string>();
    await Promise.all([...heroIds].map(async (id) => {
      nameMap.set(id, await dotaDataService.getHeroName(id).catch(() => `Hero ${id}`));
    }));

    const embed = new EmbedBuilder()
      .setColor('#16a34a')
      .setTitle('🟢 Turbo Meta — Best Heroes by Position')
      .setDescription(
        'Live from **STRATZ**, all brackets, last 7 days (current patch). Ranked by **Wilson 95% lower-bound win rate** so small samples can\'t spike the list. Each cell shows raw WR and game count.',
      )
      .setTimestamp();

    for (let pos = 1; pos <= 5; pos++) {
      const rows = byPosition[pos] ?? [];
      const { ranked, gate } = rankPosition(rows);
      if (ranked.length === 0) {
        embed.addFields({ name: POSITION_LABELS[pos], value: '_not enough data_', inline: false });
        continue;
      }
      const lines = ranked.slice(0, TOP_N).map((h, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${i + 1}.\``;
        const name = nameMap.get(h.heroId) ?? `Hero ${h.heroId}`;
        return `${medal} **${name}** — ${(h.winRate * 100).toFixed(1)}% WR · ${fmtGames(h.matchCount)} games`;
      });
      embed.addFields({
        name: `${POSITION_LABELS[pos]}  _(min ${fmtGames(gate)} games)_`,
        value: lines.join('\n').slice(0, 1024),
        inline: false,
      });
    }

    embed.addFields({
      name: 'Method & caveats',
      value:
        'Win rate is pooled across **all** skill brackets (Turbo has no separate ranked brackets), so this is "what wins in Turbo overall," not skill-controlled. ' +
        'Ranking uses the Wilson lower bound, not raw WR, and applies a per-role sample gate. Data is a rolling 7-day window — it tracks the current patch automatically.',
      inline: false,
    });

    await loading.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbometa command:', error);
    await loading.edit('An error occurred while building the Turbo meta. Please try again later.').catch(() => {});
  }
}
