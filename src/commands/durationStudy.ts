import { EmbedBuilder, Message } from 'discord.js';
import { opendotaClient } from '../services/apiClient';
import { logger } from '../services/loggerService';
import { UserDataService } from '../services/userDataService';
import { formatDuration } from '../utils/formatters';

const TURBO_MODE = 23;
const NORMAL_MODES = new Set([1, 22]); // All Pick, Ranked All Pick.
const DEFAULT_DAYS = 365;
const MATCH_LIMIT = 500;
const FETCH_BATCH_SIZE = 3;
const MIN_DURATION_SEC = 5 * 60;
const MAX_DURATION_SEC = 120 * 60;

interface ModeDuration {
  games: number;
  totalSeconds: number;
}

interface DurationRow {
  name: string;
  steamId: string;
  turbo: ModeDuration;
  normal: ModeDuration;
}

function emptyMode(): ModeDuration {
  return { games: 0, totalSeconds: 0 };
}

function avgSeconds(mode: ModeDuration): number | null {
  return mode.games ? mode.totalSeconds / mode.games : null;
}

function fmtAvg(mode: ModeDuration): string {
  const avg = avgSeconds(mode);
  return avg == null ? 'n/a' : `${formatDuration(Math.round(avg))} (${mode.games}g)`;
}

function fmtDelta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'n/a';
  const sign = seconds >= 0 ? '+' : '-';
  return `${sign}${formatDuration(Math.round(Math.abs(seconds)))}`;
}

function avg(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function fitLines(lines: string[], emptyText: string, limit = 1000): string {
  if (!lines.length) return emptyText;
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const extra = lines[i].length + (out.length ? 1 : 0);
    if (used + extra > limit) {
      const tail = `...and ${lines.length - i} more.`;
      if (used + tail.length + (out.length ? 1 : 0) <= limit) out.push(tail);
      break;
    }
    out.push(lines[i]);
    used += extra;
  }
  return out.join('\n');
}

function parseWindow(args: string[]): { days: number | null; scopeLabel: string } {
  const lowered = args.map((arg) => arg.toLowerCase());
  if (lowered.includes('all') || lowered.includes('lifetime')) {
    return { days: null, scopeLabel: `last ${MATCH_LIMIT} OpenDota matches/player` };
  }
  const numeric = lowered.find((arg) => /^\d+$/.test(arg));
  const days = numeric ? Math.max(7, Math.min(3650, Number(numeric))) : DEFAULT_DAYS;
  return { days, scopeLabel: `last ${days} days` };
}

async function displayName(message: Message, discordId: string): Promise<string> {
  const user = await message.client.users.fetch(discordId).catch(() => null);
  return user?.username ?? `Discord ${discordId}`;
}

async function fetchDurations(steamId: string, days: number | null): Promise<{ turbo: ModeDuration; normal: ModeDuration }> {
  const params = new URLSearchParams({
    significant: '0',
    limit: String(MATCH_LIMIT),
    project: 'duration',
  });
  params.append('project', 'game_mode');
  if (days != null) params.set('date', String(days));

  const matches = await opendotaClient
    .get<any[]>(`/players/${steamId}/matches?${params.toString()}`)
    .then((res) => res.data || []);

  const turbo = emptyMode();
  const normal = emptyMode();

  for (const match of matches) {
    const duration = Number(match.duration || 0);
    if (!Number.isFinite(duration) || duration < MIN_DURATION_SEC || duration > MAX_DURATION_SEC) continue;

    const mode = Number(match.game_mode);
    if (mode === TURBO_MODE) {
      turbo.games++;
      turbo.totalSeconds += duration;
    } else if (NORMAL_MODES.has(mode)) {
      normal.games++;
      normal.totalSeconds += duration;
    }
  }

  return { turbo, normal };
}

export async function durationStudy(message: Message, args: string[], userDataService: UserDataService) {
  const { days, scopeLabel } = parseWindow(args);
  const registered = userDataService.getAllUsers();
  if (!registered.length) return message.reply('No registered players to study yet.');

  const progress = await message.reply(
    `⏱️ Checking crew game duration across **${registered.length}** registered player(s)... ${scopeLabel}.`,
  );

  try {
    const rows: DurationRow[] = [];
    for (let i = 0; i < registered.length; i += FETCH_BATCH_SIZE) {
      const batch = registered.slice(i, i + FETCH_BATCH_SIZE);
      const fetched = await Promise.all(batch.map(async (user) => {
        const [name, durations] = await Promise.all([
          displayName(message, user.discordId),
          fetchDurations(user.steamId, days),
        ]);
        return { name, steamId: user.steamId, ...durations };
      }));
      rows.push(...fetched);
      const checked = Math.min(registered.length, i + batch.length);
      if (checked === registered.length || checked % 6 === 0) {
        progress.edit(`⏱️ Checking crew game duration... ${checked}/${registered.length} player(s).`).catch(() => {});
      }
    }

    const withTurbo = rows.filter((row) => row.turbo.games > 0);
    const withNormal = rows.filter((row) => row.normal.games > 0);
    const comparable = rows.filter((row) => row.turbo.games > 0 && row.normal.games > 0);
    if (!withTurbo.length || !withNormal.length) {
      return progress.edit('Not enough Turbo and normal All Pick / Ranked All Pick data to compare durations.');
    }

    const turboTotal = withTurbo.reduce((acc, row) => ({
      games: acc.games + row.turbo.games,
      totalSeconds: acc.totalSeconds + row.turbo.totalSeconds,
    }), emptyMode());
    const normalTotal = withNormal.reduce((acc, row) => ({
      games: acc.games + row.normal.games,
      totalSeconds: acc.totalSeconds + row.normal.totalSeconds,
    }), emptyMode());

    const gameTurboAvg = avgSeconds(turboTotal);
    const gameNormalAvg = avgSeconds(normalTotal);
    const playerTurboAvg = avg(comparable.map((row) => avgSeconds(row.turbo)!).filter(Number.isFinite));
    const playerNormalAvg = avg(comparable.map((row) => avgSeconds(row.normal)!).filter(Number.isFinite));
    const playerDelta = playerTurboAvg != null && playerNormalAvg != null ? playerTurboAvg - playerNormalAvg : null;
    const gameDelta = gameTurboAvg != null && gameNormalAvg != null ? gameTurboAvg - gameNormalAvg : null;

    const verdict = playerDelta == null
      ? 'Not enough comparable players.'
      : Math.abs(playerDelta) < 60
        ? 'Crew Turbo and normal games are basically the same length by player-weighted average.'
        : playerDelta > 0
          ? `Crew Turbo games are **${fmtDelta(playerDelta)} longer** than normal by player-weighted average.`
          : `Crew Turbo games are **${fmtDelta(playerDelta)} shorter** than normal by player-weighted average.`;

    const playerLines = comparable
      .map((row) => {
        const turboAvg = avgSeconds(row.turbo)!;
        const normalAvg = avgSeconds(row.normal)!;
        return { row, delta: turboAvg - normalAvg };
      })
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 10)
      .map(({ row, delta }) => `**${row.name}** — Turbo ${fmtAvg(row.turbo)} vs normal ${fmtAvg(row.normal)} (${fmtDelta(delta)})`);

    const missingLines = [
      rows.filter((row) => row.turbo.games === 0).length ? `${rows.filter((row) => row.turbo.games === 0).length} player(s) had no Turbo games in scope.` : null,
      rows.filter((row) => row.normal.games === 0).length ? `${rows.filter((row) => row.normal.games === 0).length} player(s) had no normal AP/ranked AP games in scope.` : null,
    ].filter((line): line is string => !!line);

    const embed = new EmbedBuilder()
      .setColor('#38bdf8')
      .setTitle('⏱️ Crew Game Duration Study')
      .setDescription(verdict)
      .addFields(
        {
          name: 'Coverage',
          value:
            `Players checked: **${registered.length}** | comparable: **${comparable.length}**\n` +
            `Turbo games: **${turboTotal.games}** | normal AP/ranked AP games: **${normalTotal.games}**\n` +
            `Scope: **${scopeLabel}**`,
          inline: false,
        },
        {
          name: 'Averages',
          value:
            `Game-weighted: Turbo **${formatDuration(Math.round(gameTurboAvg ?? 0))}** vs normal **${formatDuration(Math.round(gameNormalAvg ?? 0))}** (${fmtDelta(gameDelta)})\n` +
            `Player-weighted: Turbo **${formatDuration(Math.round(playerTurboAvg ?? 0))}** vs normal **${formatDuration(Math.round(playerNormalAvg ?? 0))}** (${fmtDelta(playerDelta)})`,
          inline: false,
        },
        {
          name: 'Player Splits',
          value: fitLines(playerLines, 'No player had both Turbo and normal games in scope.'),
          inline: false,
        },
        {
          name: 'Method',
          value:
            `Turbo = game mode 23. Normal = All Pick + Ranked All Pick only, so weird modes do not pollute the comparison. ` +
            `Matches under 5m or over 120m are excluded as likely remakes/outliers. Player-weighted average gives each comparable player one vote, so high-volume players do not dominate.`,
          inline: false,
        },
      )
      .setTimestamp();

    if (missingLines.length) {
      embed.addFields({ name: 'Missing Data', value: missingLines.join('\n'), inline: false });
    }

    await progress.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in durationstudy command:', error);
    await progress.edit('Failed to build the crew duration study. OpenDota may be rate-limited; try again later.');
  }
}

