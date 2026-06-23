import { EmbedBuilder, Message } from 'discord.js';
import { TurboRankObservation } from '../models/TurboRank';
import { mmrToMedal, turboRankService } from '../services/turboRankService';
import { UserDataService } from '../services/userDataService';
import { logger } from '../services/loggerService';

const RECENCY_HALF_LIFE_DAYS = 60;

interface PartyStudyRow {
  steamId: string;
  name: string;
  discovered?: boolean;
  officialMMR: number;
  officialMedal: string;
  partyFallback: boolean;
  solo: TurboRankObservation[];
  party: TurboRankObservation[];
  soloRead: number | null;
  partyRead: number | null;
  mixedRead: number | null;
  partyDelta: number | null;
  mixedDelta: number | null;
}

function weightedLobbyRead(observations: TurboRankObservation[]): number | null {
  if (observations.length === 0) return null;
  const now = Date.now() / 1000;
  const decayLambda = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 86400);
  let totalWeight = 0;
  let weightedSum = 0;

  for (const obs of observations) {
    const ageSec = Math.max(0, now - obs.timestamp);
    const recency = Math.exp(-decayLambda * ageSec);
    const completeness = Math.min(obs.visibleRanks || 0, 9) / 9;
    const weight = recency * completeness;
    totalWeight += weight;
    weightedSum += obs.lobbyMMR * weight;
  }

  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
}

function fmtMmr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${Math.round(value)} MMR`;
}

function fmtAbsMmr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${Math.round(Math.abs(value))} MMR`;
}

function fmtRead(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${mmrToMedal(value).medal} (~${Math.round(value)})`;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fitLines(lines: string[], emptyText: string, limit = 1000): string {
  if (lines.length === 0) return emptyText;
  const selected: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const extra = selected.length ? 1 : 0;
    if (used + lines[i].length + extra > limit) {
      const tail = `...and ${lines.length - i} more.`;
      const tailExtra = selected.length ? 1 : 0;
      if (used + tail.length + tailExtra <= limit) selected.push(tail);
      break;
    }
    selected.push(lines[i]);
    used += lines[i].length + extra;
  }
  return selected.join('\n');
}

function matchLink(matchId: number): string {
  return `[#${matchId}](https://stratz.com/matches/${matchId})`;
}

function buildSharedSoloLines(rows: PartyStudyRow[]): string[] {
  const byMatch = new Map<number, Set<string>>();
  for (const row of rows) {
    for (const obs of row.solo) {
      const names = byMatch.get(obs.matchId) ?? new Set<string>();
      names.add(row.name);
      byMatch.set(obs.matchId, names);
    }
  }

  return [...byMatch.entries()]
    .filter(([, names]) => names.size > 1)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 6)
    .map(([matchId, names]) => `${matchLink(matchId)} · ${[...names].slice(0, 4).join(', ')}${names.size > 4 ? ` +${names.size - 4}` : ''}`);
}

function buildRow(entry: ReturnType<typeof turboRankService.getAllEstimates>[number], userDataService: UserDataService): PartyStudyRow {
  const observations = turboRankService.getObservationsBySteamId(entry.steamId);
  const solo = observations.filter((obs) => obs.partySize === 1);
  const party = observations.filter((obs) => obs.partySize > 1);
  const soloRead = weightedLobbyRead(solo);
  const partyRead = weightedLobbyRead(party);
  const mixedRead = weightedLobbyRead([...solo, ...party]);
  const registered = userDataService.getUserBySteamId(entry.steamId);
  const name = entry.steamName ?? (registered?.discordId ? `<@${registered.discordId}>` : `Steam ${entry.steamId}`);

  return {
    steamId: entry.steamId,
    name,
    discovered: entry.discovered,
    officialMMR: entry.estimate.estimatedMMR,
    officialMedal: entry.estimate.medal,
    partyFallback: entry.estimate.partyFallback,
    solo,
    party,
    soloRead,
    partyRead,
    mixedRead,
    partyDelta: soloRead != null && partyRead != null ? partyRead - soloRead : null,
    mixedDelta: soloRead != null && mixedRead != null ? mixedRead - soloRead : null,
  };
}

export async function turboStudyParty(message: Message, args: string[], userDataService: UserDataService) {
  try {
    const crewOnly = ['crew', 'friends', 'mine', 'squad'].includes((args[0] ?? '').toLowerCase());
    const estimates = turboRankService.getAllEstimates()
      .filter((entry) => !crewOnly || !entry.discovered);

    if (estimates.length < 2) {
      return message.reply(
        crewOnly
          ? 'Need at least 2 non-discovered calibrated players to study party contamination.'
          : 'Need at least 2 calibrated players to study party contamination.',
      );
    }

    const rows = estimates.map((entry) => buildRow(entry, userDataService));
    const rowsWithObs = rows.filter((row) => row.solo.length + row.party.length > 0);
    const bothRows = rows.filter((row) => row.soloRead != null && row.partyRead != null);
    const partyFallbackRows = rows.filter((row) => row.partyFallback);
    const partyRowsExcluded = rows
      .filter((row) => row.solo.length > 0)
      .reduce((sum, row) => sum + row.party.length, 0);

    const soloObs = rows.reduce((sum, row) => sum + row.solo.length, 0);
    const partyObs = rows.reduce((sum, row) => sum + row.party.length, 0);
    const avgPartyDelta = average(bothRows.map((row) => row.partyDelta!).filter(Number.isFinite));
    const avgMixedShift = average(bothRows.map((row) => Math.abs(row.mixedDelta!)).filter(Number.isFinite));
    const avgOfficialVsMixed = average(
      bothRows
        .map((row) => row.mixedRead == null ? null : row.mixedRead - row.officialMMR)
        .filter((value): value is number => value != null && Number.isFinite(value)),
    );

    const biggestMixed = [...bothRows]
      .filter((row) => row.mixedDelta != null)
      .sort((a, b) => Math.abs(b.mixedDelta!) - Math.abs(a.mixedDelta!))
      .slice(0, 6)
      .map((row) =>
        `**${row.name}**: solo ${fmtRead(row.soloRead)} -> mixed ${fmtRead(row.mixedRead)} (${fmtMmr(row.mixedDelta)}) · party read ${fmtMmr(row.partyDelta)} vs solo (${row.party.length} party)`,
      );

    const partyFallbackLines = partyFallbackRows
      .slice(0, 6)
      .map((row) => `**${row.name}**: ${row.officialMedal} · ${row.party.length} party obs · confidence based on party fallback`);

    const sharedSolo = buildSharedSoloLines(rows);
    const partySizes = [2, 3, 4, 5]
      .map((size) => {
        const n = rows.reduce((sum, row) => sum + row.party.filter((obs) => obs.partySize === size).length, 0);
        return n > 0 ? `${size}-stack: **${n}**` : null;
      })
      .filter((line): line is string => !!line);

    const verdict = bothRows.length === 0
      ? 'Not enough players have both solo and party rows in the cached dataset. Official ranks are still protected because solo rows are used first.'
      : `Party lobbies read **${fmtMmr(avgPartyDelta)}** vs the same players' solo lobbies on average. Mixing party rows would move those players by about **${fmtAbsMmr(avgMixedShift)}** on average, so keeping official ranks solo-first is still the right default.`;

    const embed = new EmbedBuilder()
      .setColor('#14b8a6')
      .setTitle(crewOnly ? '🧪 Turbo Study — Party Contamination (Crew)' : '🧪 Turbo Study — Party Contamination')
      .setDescription(
        'Read-only diagnostic from cached `+turborank` observations. It does **not** change official ranks, lean, or leaderboards.',
      )
      .addFields(
        {
          name: 'Verdict',
          value: verdict,
          inline: false,
        },
        {
          name: 'Coverage',
          value:
            `Players studied: **${rowsWithObs.length}/${rows.length}**\n` +
            `Solo observations: **${soloObs}** | party observations: **${partyObs}**\n` +
            `Players with both solo+party rows: **${bothRows.length}**\n` +
            `Party-fallback official estimates: **${partyFallbackRows.length}**\n` +
            `Party rows excluded from official solo-first ranks: **${partyRowsExcluded}**`,
          inline: false,
        },
        {
          name: 'Party Size Mix',
          value: partySizes.length ? partySizes.join('\n') : 'No cached party observations in this scope.',
          inline: true,
        },
        {
          name: 'Mixed-Estimate Drift',
          value:
            `Avg absolute solo -> mixed shift: **${fmtAbsMmr(avgMixedShift)}**\n` +
            `Avg mixed read vs official estimate: **${fmtMmr(avgOfficialVsMixed)}**\n` +
            '_Mixed read is diagnostic only; official rank remains solo-first._',
          inline: true,
        },
        {
          name: 'Biggest Party Shifts',
          value: fitLines(biggestMixed, 'No players have both solo and party observations yet.'),
          inline: false,
        },
        {
          name: 'Party-Fallback Players',
          value: fitLines(partyFallbackLines, 'None. Every official estimate in this scope has solo signal.'),
          inline: false,
        },
        {
          name: 'Shared Solo Audit Candidates',
          value: fitLines(
            sharedSolo,
            'No duplicate cached solo match IDs across studied players.',
            850,
          ) + '\n_Not proof of party queue — just the best cached matches to manually audit if solo detection is questioned._',
          inline: false,
        },
        {
          name: 'Next Actions',
          value:
            'Use `+turborank audit <player>` on the biggest shifts or party-fallback players.\n' +
            'Use `+turbostudyparty crew` to exclude discovered randoms.',
          inline: false,
        },
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbostudyparty command:', error);
    await message.reply('An error occurred while building the Turbo party study. Please try again later.');
  }
}
