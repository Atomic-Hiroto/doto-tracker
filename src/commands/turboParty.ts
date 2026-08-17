import { EmbedBuilder, Message } from 'discord.js';
import { TurboStatsScope } from '../models/TurboStats';
import { TurboStatsService } from '../services/turboStatsService';
import { UserDataService } from '../services/userDataService';
import { logger } from '../services/loggerService';

function parseScope(args: string[]): TurboStatsScope {
  if (args.some(arg => ['tracked', 'live'].includes(arg.toLowerCase()))) return 'tracked';
  if (args.some(arg => ['history', 'historical', 'past'].includes(arg.toLowerCase()))) return 'history';
  return 'all';
}

function parseWindow(args: string[]) {
  const allTime = args.some(arg => ['all', 'alltime', 'all-time', 'forever'].includes(arg.toLowerCase()));
  if (allTime) return { sinceTimestamp: undefined, label: 'all imported history' };
  const requested = args.map(arg => Number.parseInt(arg, 10)).find(value => Number.isFinite(value));
  const days = Math.max(7, Math.min(1825, requested || 60));
  return {
    sinceTimestamp: Math.floor(Date.now() / 1000) - days * 86400,
    label: `last ${days} days`
  };
}

export async function turboParty(message: Message, args: string[], users: UserDataService, stats: TurboStatsService) {
  try {
    const scope = parseScope(args);
    const window = parseWindow(args);
    const nameOf = async (id: string) => {
      try { return (await message.client.users.fetch(id)).username; } catch { return `<@${id}>`; }
    };

    // One to four mentions reads as "build a party around these players" — those get locked into
    // every lineup considered. Five or more reads as "pick the best five out of exactly this pool".
    const mentioned = [...message.mentions.users.keys()];
    const required = mentioned.length > 0 && mentioned.length < 5 ? mentioned : [];
    let candidateIds = required.length ? [] : mentioned;
    if (!candidateIds.length) {
      candidateIds = users.getAllUsers()
        .map(user => ({ id: user.discordId, games: (() => { const s = stats.getPlayerStats(user.discordId, scope, window.sinceTimestamp); return s ? s.wins + s.losses : 0; })() }))
        .filter(player => player.games > 0)
        .sort((a, b) => b.games - a.games)
        .slice(0, 20)
        .map(player => player.id);
      // A locked-in player belongs in the pool even if they are too thin to reach the top 20.
      for (const id of required) if (!candidateIds.includes(id)) candidateIds.push(id);
    }
    if (candidateIds.length < 5) {
      const next = scope === 'tracked'
        ? 'The tracked ledger starts with the new system; use `+turboparty best` while new live matches accumulate.'
        : 'Run `+turbobackfill` after registering more players.';
      return message.reply(`Only ${candidateIds.length} registered players have ${scope} evidence. ${next}`);
    }

    const requiredNames = await Promise.all(required.map(nameOf));
    const recommendations = stats.recommendParties(candidateIds, scope, 3, window.sinceTimestamp, required);
    if (!recommendations.length) {
      const next = scope === 'tracked'
        ? 'Use `+turboparty best` while new live matches accumulate.'
        : 'Run `+turbobackfill`, then try again.';
      const who = required.length
        ? ` No lineup containing ${requiredNames.join(' and ')} clears that bar — they need more games with the rest of the pool.`
        : '';
      return message.reply(`There is not enough connected evidence yet (at least 7 of 10 duo links need 5+ games).${who} ${next}`);
    }

    const fields = [];
    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      const names = await Promise.all(rec.playerIds.map(nameOf));
      const pairName = async (pair: typeof rec.strongestPair) => {
        if (!pair) return 'n/a';
        const resolved = await Promise.all([pair.player1, pair.player2].map(nameOf));
        return `${resolved.join(' + ')} (${pair.wins}-${pair.losses})`;
      };
      fields.push({
        name: `${i === 0 ? '🏆' : `${i + 1}.`} ${names.join(' · ')}`,
        value: `Rank score **${rec.score.toFixed(1)}** — the projection minus a penalty for how thin its evidence is\n` +
          `Projected WR: ${(rec.predictedWinRate * 100).toFixed(1)}% (${(rec.lowWinRate * 100).toFixed(1)}–${(rec.highWinRate * 100).toFixed(1)}%)\n` +
          `Evidence: ${rec.coveredPairs}/10 duo links · ${rec.averagePairGames.toFixed(1)} avg games/link · exact lineup ${rec.exactLineupWins}/${rec.exactLineupGames}\n` +
          `Strongest duo: ${await pairName(rec.strongestPair)}\nWeakest observed duo: ${await pairName(rec.weakestPair)}`,
        inline: false
      });
    }

    // The ranking is only meaningful if the leader actually separates from the field. It usually
    // does not at five-player granularity, so state that in the embed rather than implying a gap.
    const leader = recommendations[0];
    const share = leader.evaluatedLineups ? leader.indistinguishableLineups / leader.evaluatedLineups : 0;
    fields.push({
      name: 'How much to trust this',
      value: `${leader.evaluatedLineups} lineups had enough evidence to rank. `
        + `${leader.indistinguishableLineups} of them have a projection inside the leader's `
        + `${(leader.lowWinRate * 100).toFixed(1)}–${(leader.highWinRate * 100).toFixed(1)}% interval.`
        + (share >= 0.5
          ? ' At that spread the order is a tiebreak on confidence, not a real gap — treat these as equivalent and pick on vibes.'
          : ''),
      inline: false
    });

    const embed = new EmbedBuilder()
      .setColor('#8b5cf6')
      .setTitle(required.length ? `🧩 Optimal Turbo Party — ${requiredNames.join(' + ')}` : '🧩 Optimal Turbo Party')
      .setDescription(
        (required.length
          ? `Best five-player combinations **containing ${requiredNames.join(' and ')}**, drawn from **${candidateIds.length}** candidates`
          : `Best five-player combinations from **${candidateIds.length}** candidates`)
        + ` · **${window.label}** · scope: **${scope}**`)
      .addFields(fields)
      .setFooter({ text: 'Projection: neutral 10–10 priors + duo synergy + exact-lineup evidence. Association, not a causal guarantee.' })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo party optimizer:', error);
    return message.reply('An error occurred while calculating the optimal Turbo party. Please try again later.');
  }
}
