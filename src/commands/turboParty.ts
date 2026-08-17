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

export async function turboParty(message: Message, args: string[], users: UserDataService, stats: TurboStatsService) {
  try {
    const scope = parseScope(args);
    let candidateIds = [...message.mentions.users.keys()];
    if (candidateIds.length > 0 && candidateIds.length < 5) {
      return message.reply('Mention at least 5 registered players to define a candidate pool, or use `+turboparty best [all|tracked|history]` for everyone.');
    }
    if (!candidateIds.length) {
      candidateIds = users.getAllUsers()
        .map(user => ({ id: user.discordId, games: (() => { const s = stats.getPlayerStats(user.discordId, scope); return s ? s.wins + s.losses : 0; })() }))
        .filter(player => player.games > 0)
        .sort((a, b) => b.games - a.games)
        .slice(0, 20)
        .map(player => player.id);
    }
    if (candidateIds.length < 5) {
      return message.reply(`Only ${candidateIds.length} registered players have ${scope} evidence. Run \`+turbobackfill\` after registering more players.`);
    }

    const recommendations = stats.recommendParties(candidateIds, scope, 3);
    if (!recommendations.length) {
      return message.reply('There is not enough connected evidence yet (at least 6 of 10 duo links need 2+ games). Run `+turbobackfill`, then try again.');
    }

    const fields = [];
    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      const names = await Promise.all(rec.playerIds.map(async id => {
        try { return (await message.client.users.fetch(id)).username; } catch { return `<@${id}>`; }
      }));
      const pairName = async (pair: typeof rec.strongestPair) => {
        if (!pair) return 'n/a';
        const ids = [pair.player1, pair.player2];
        const resolved = await Promise.all(ids.map(async id => {
          try { return (await message.client.users.fetch(id)).username; } catch { return `<@${id}>`; }
        }));
        return `${resolved.join(' + ')} (${pair.wins}-${pair.losses})`;
      };
      fields.push({
        name: `${i === 0 ? '🏆' : `${i + 1}.`} ${names.join(' · ')}`,
        value: `Projected WR: **${(rec.predictedWinRate * 100).toFixed(1)}%** (${(rec.lowWinRate * 100).toFixed(1)}–${(rec.highWinRate * 100).toFixed(1)}%)\n` +
          `Evidence: ${rec.coveredPairs}/10 duo links · ${rec.averagePairGames.toFixed(1)} avg games/link · exact lineup ${rec.exactLineupWins}/${rec.exactLineupGames}\n` +
          `Strongest duo: ${await pairName(rec.strongestPair)}\nWeakest observed duo: ${await pairName(rec.weakestPair)}`,
        inline: false
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#8b5cf6')
      .setTitle('🧩 Optimal Turbo Party')
      .setDescription(`Best five-player combinations from **${candidateIds.length}** candidates · scope: **${scope}**`)
      .addFields(fields)
      .setFooter({ text: 'Experimental projection: shrunk player WR + duo synergy + exact-lineup evidence. Association, not a causal guarantee.' })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo party optimizer:', error);
    return message.reply('An error occurred while calculating the optimal Turbo party. Please try again later.');
  }
}
