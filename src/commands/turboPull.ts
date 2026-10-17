import { EmbedBuilder, Message } from 'discord.js';
import { logger } from '../services/loggerService';
import { TurboStatsService } from '../services/turboStatsService';
import { turboRankService, mmrToMedal } from '../services/turboRankService';

const MMR_PER_STAR = 153;
const MAX_LINES = 24;

type PullPlayer = ReturnType<TurboStatsService['getPullRatings']>['players'][number];

function parseWindow(args: string[]) {
  const requested = args.map(arg => Number.parseInt(arg, 10)).find(value => Number.isFinite(value) && value > 0);
  if (!requested) return { sinceTimestamp: undefined, label: 'all imported history' };
  const days = Math.max(7, Math.min(1825, requested));
  return { sinceTimestamp: Math.floor(Date.now() / 1000) - days * 86400, label: `the last ${days} days` };
}

function quantile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))];
}

const signed = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(Math.round(value))}`;

async function displayName(message: Message, player: { discordId: string; steamId: string }) {
  const user = await message.client.users.fetch(player.discordId).catch(() => null);
  return user?.username || turboRankService.getSteamName(player.steamId) || player.steamId || player.discordId;
}

/**
 * `+turbopull [@user ...|me] [days]` — who makes the enemies harder when they join your Turbo party.
 *
 * With nobody named it is the server board of pull ratings. Name a party (one or more players, `me`
 * for yourself) and every other rated player is listed by how far they would move that party's
 * enemies: a party queues on its average, so a new member shifts it by
 * (their pull − the party's) ÷ the new party size.
 */
export async function turboPull(message: Message, turboStatsService: TurboStatsService, args: string[] = []) {
  try {
    const window = parseWindow(args);
    const enemyByMatch = turboRankService.getEnemyStrengthByMatch({ registeredOnly: true, minVisibleEnemies: 2 });
    const { players, scoredTeams } = turboStatsService.getPullRatings(enemyByMatch, 20, window.sinceTimestamp);
    if (players.length < 2) {
      return message.reply(
        `Not enough rank-scored Turbo games in ${window.label} to rate anyone yet (${scoredTeams} scored). `
        + 'Enemy ranks come from `+turborank calibrate`, so calibrating more players fills this in.'
      );
    }

    const partyIds = [...message.mentions.users.keys()];
    if (args.some(arg => ['me', 'my', 'mine'].includes(arg.toLowerCase())) && !partyIds.includes(message.author.id)) {
      partyIds.unshift(message.author.id);
    }

    const footer = `${scoredTeams} rank-scored games · enemy ranks are their visible ranked medals`;
    const byId = new Map(players.map(player => [player.discordId, player]));

    if (!partyIds.length) {
      const sorted = [...players].sort((a, b) => b.rating - a.rating).slice(0, MAX_LINES);
      const lines = await Promise.all(sorted.map(async (player, i) => {
        const low = quantile(player.samples, 0.05);
        const high = quantile(player.samples, 0.95);
        return `${i + 1}. **${await displayName(message, player)}** — **${mmrToMedal(player.rating).medal}** `
          + `(${Math.round(player.rating)}, likely ${Math.round(low)}–${Math.round(high)}) · ${player.games} games`;
      }));
      const embed = new EmbedBuilder()
        .setColor('#a855f7')
        .setTitle('🧲 Turbo Pull — who brings harder enemies')
        .setDescription(
          '**How strong your enemies get when this person is in your party.** '
          + `It's the average real rank of the enemies we faced in ${scoredTeams} of our own games (${window.label}), `
          + 'so stack with someone high on the list for tougher lobbies, or someone low for easier ones.\n'
          + '`+turbopull me` or `+turbopull @a @b` checks a party.\n\n'
          + lines.join('\n')
        )
        .setFooter({ text: `${footer} · not the same number as +turborank` })
        .setTimestamp();
      return message.reply({ embeds: [embed] });
    }

    const missing = partyIds.filter(id => !byId.has(id));
    if (missing.length) {
      const names = await Promise.all(missing.map(async id => (await message.client.users.fetch(id).catch(() => null))?.username || id));
      return message.reply(
        `No pull rating yet for **${names.join(', ')}** — they need 20+ rank-scored Turbo games in ${window.label}. `
        + '`+turbopull` lists everyone who has one.'
      );
    }
    if (partyIds.length >= 5) return message.reply('That party is already full — name up to 4 players to see who would fill it.');

    const party = partyIds.map(id => byId.get(id)!);
    const k = party.length;
    const partyRating = party.reduce((sum, player) => sum + player.rating, 0) / k;
    const partySamples = party[0].samples.map((_, t) => party.reduce((sum, player) => sum + player.samples[t], 0) / k);

    const candidates = players
      .filter(player => !partyIds.includes(player.discordId))
      .map(player => {
        const shift = (player.rating - partyRating) / (k + 1);
        const shifts = player.samples.map((value, t) => (value - partySamples[t]) / (k + 1));
        return { player, shift, low: quantile(shifts, 0.05), high: quantile(shifts, 0.95) };
      })
      .sort((a, b) => b.shift - a.shift)
      .slice(0, MAX_LINES);

    const partyNames = await Promise.all(party.map(player => displayName(message, player)));
    const lines = await Promise.all(candidates.map(async ({ player, shift, low, high }) => {
      // Too close to call when the interval straddles zero, or the move is under half a medal star.
      const settled = (low > 0 || high < 0) && Math.abs(shift) >= MMR_PER_STAR / 2;
      const icon = !settled ? '➖' : shift > 0 ? '⬆️' : '⬇️';
      const stars = Math.round(Math.abs(shift) / MMR_PER_STAR);
      const starText = settled && stars ? ` (~${stars}★ ${shift > 0 ? 'harder' : 'easier'})` : '';
      return `${icon} **${await displayName(message, player)}** · **${signed(shift)} MMR**${starText} `
        + `→ ${mmrToMedal(partyRating + shift).medal} enemies`;
    }));

    const who = k === 1 ? partyNames[0] : partyNames.join(' + ');
    const embed = new EmbedBuilder()
      .setColor('#a855f7')
      .setTitle(`🧲 Turbo Pull — who joining ${who} makes it harder`)
      .setDescription(
        `${k === 1 ? `${who} alone pulls` : 'This party pulls'} **${mmrToMedal(partyRating).medal}** enemies (${Math.round(partyRating)}) · ${window.label}\n`
        + 'How each player would move that, hardest first. ➖ = too close to call.\n\n'
        + lines.join('\n')
      )
      .setFooter({ text: footer })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo pull command:', error);
    return message.reply('An error occurred while working out turbo pull. Please try again later.');
  }
}
