import { EmbedBuilder, Message } from 'discord.js';
import { TurboStatsService } from '../services/turboStatsService';
import { turboRankService, mmrToMedal } from '../services/turboRankService';
import { logger } from '../services/loggerService';
import { displayName, parseWindow } from './turboPull';

const ACTIVE_DAYS = 60;
const HARDER_NOT_LOSSES = 'Tougher enemies don\'t mean more losses, since matchmaking keeps every party near 50%. '
  + 'Pick easy for a chill game, tough for practice. `+turbopull` shows any single player\'s effect.';

type PullPlayer = ReturnType<TurboStatsService['getPullRatings']>['players'][number];

/**
 * `+turboparty [@user ...|me] [days]` — plan a Turbo five-stack for easier or tougher lobbies.
 *
 * It used to optimise win rate, but in forward tests duo and lineup records predicted nothing and
 * the projection lost to a coin flip: Turbo matchmaking pulls every party back toward 50%. What a
 * party does change is how strong its enemies are, close to the average of its members' pull
 * ratings (`+turbopull`), so this fills the named players up to five from recently active players
 * to make that as low or as high as it can go.
 */
export async function turboParty(message: Message, stats: TurboStatsService, args: string[] = []) {
  try {
    const window = parseWindow(args);
    const enemyByMatch = turboRankService.getEnemyStrengthByMatch({ registeredOnly: true, minVisibleEnemies: 2 });
    const { players, scoredTeams } = stats.getPullRatings(enemyByMatch, 20, window.sinceTimestamp);
    const byId = new Map(players.map(player => [player.discordId, player]));

    const lockedIds = [...message.mentions.users.keys()];
    const wantsSelf = args.some(arg => ['me', 'my', 'mine'].includes(arg.toLowerCase()));
    // With nobody named, plan around the caller when they have a rating, else across everyone.
    if ((wantsSelf || !lockedIds.length) && byId.has(message.author.id) && !lockedIds.includes(message.author.id)) {
      lockedIds.unshift(message.author.id);
    }
    if (lockedIds.length > 5) return message.reply('A party is five players — name up to 5.');

    const missing = lockedIds.filter(id => !byId.has(id));
    if (missing.length) {
      const names = await Promise.all(missing.map(async id => (await message.client.users.fetch(id).catch(() => null))?.username || id));
      return message.reply(
        `No pull rating yet for **${names.join(', ')}**: they need 20+ rank-scored Turbo games in ${window.label}. `
        + '`+turbopull` lists everyone who has one.'
      );
    }

    const locked = lockedIds.map(id => byId.get(id)!);
    const activeSince = Math.floor(Date.now() / 1000) - ACTIVE_DAYS * 86400;
    const pool = players.filter(player => !lockedIds.includes(player.discordId) && player.lastPlayed >= activeSince);
    const need = 5 - locked.length;
    if (pool.length < need) {
      return message.reply(`Only ${pool.length} other rated players have played Turbo in the last ${ACTIVE_DAYS} days, not enough to fill the party.`);
    }

    const sortedPool = [...pool].sort((a, b) => a.rating - b.rating);
    const describe = async (party: PullPlayer[]) => {
      const rating = party.reduce((sum, player) => sum + player.rating, 0) / party.length;
      const names = await Promise.all(party.map(async player => {
        const name = await displayName(message, player);
        return lockedIds.includes(player.discordId) ? name : `**${name}**`;
      }));
      return `${names.join(' · ')}\n→ **${mmrToMedal(rating).medal}** enemies on average (~${Math.round(rating)} MMR)`;
    };

    const lockedNames = await Promise.all(locked.map(player => displayName(message, player)));
    const embed = new EmbedBuilder()
      .setColor('#8b5cf6')
      .setFooter({ text: `${scoredTeams} rank-scored games · single games swing ±650 MMR around these averages` })
      .setTimestamp();

    if (!need) {
      return message.reply({
        embeds: [embed
          .setTitle(`🧩 Turbo Party — ${lockedNames.join(' + ')}`)
          .setDescription(`This five-stack should draw:\n${await describe(locked)}\n\n${HARDER_NOT_LOSSES}`)]
      });
    }

    const lockedText = locked.length
      ? `Filling **${lockedNames.join(' + ')}** up to five`
      : 'Best five-stacks';
    embed
      .setTitle(locked.length ? `🧩 Turbo Party — ${lockedNames.join(' + ')}` : '🧩 Turbo Party Planner')
      .setDescription(
        `${lockedText} from ${pool.length} players active in the last ${ACTIVE_DAYS} days, by how strong the enemies get `
        + `(pull from ${window.label}). New picks are in bold.\n\n${HARDER_NOT_LOSSES}`
      )
      .addFields(
        { name: '😌 Easiest lobbies', value: await describe([...locked, ...sortedPool.slice(0, need)]) },
        { name: '🔥 Toughest lobbies', value: await describe([...locked, ...sortedPool.slice(-need).reverse()]) }
      );
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo party planner:', error);
    return message.reply('An error occurred while planning the Turbo party. Please try again later.');
  }
}
