import { EmbedBuilder, Message } from 'discord.js';
import { TurboStatsService } from '../services/turboStatsService';
import { turboRankService, mmrToMedal } from '../services/turboRankService';
import { logger } from '../services/loggerService';
import { displayName, parseWindow } from './turboPull';

const ACTIVE_DAYS = 60;
const MIN_PARTY_GAMES = 10;
const MAX_ROWS = 10;
/** Top pull-rated active players considered when building potential stacks. */
const POTENTIAL_POOL = 12;
const HARDER_NOT_LOSSES = 'Tougher enemies don\'t mean more losses, since matchmaking keeps every party near 50%. '
  + 'Pick easy for a chill game, tough for practice. `+turbopull` shows any single player\'s effect.';

type PullPlayer = ReturnType<TurboStatsService['getPullRatings']>['players'][number];

/**
 * `+turboparty plan [@user ...|me] [days]` — plan a Turbo five-stack for easier or tougher lobbies.
 *
 * It used to optimise win rate, but in forward tests duo and lineup records predicted nothing and
 * the projection lost to a coin flip: Turbo matchmaking pulls every party back toward 50%. What a
 * party does change is how strong its enemies are, close to the average of its members' pull
 * ratings (`+turbopull`), so this fills the named players up to five from recently active players
 * to make that as low or as high as it can go.
 */
async function turboPartyPlan(message: Message, stats: TurboStatsService, args: string[] = []) {
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

function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of combinations(items.slice(i + 1), k - 1)) out.push([item, ...rest]);
  });
  return out;
}

/**
 * `+turboparty [@user ...|me] [days]` — the most successful Turbo parties on the server.
 *
 * Every stack of tracked players gets its own party MMR: the average rank of the enemies it drew,
 * nudged up for games won and down for games lost (`getPartyRecords`). Matchmaking keeps a regular
 * stack near 50%, so the enemy level carries most of it: a stack winning slightly more against
 * Divines ranks above one winning a lot against Legends.
 *
 * Proven parties have played 10+ games together. Potential parties are five-stacks that haven't,
 * rated as the average of their members' pull ratings. Their pair history is shown but not scored:
 * in a time-split backtest, giving pairs who did well together a bonus made the ranking worse.
 * `+turboparty plan` is the easy/tough lobby planner.
 */
export async function turboParty(message: Message, stats: TurboStatsService, args: string[] = []) {
  if (args[0]?.toLowerCase() === 'plan') return turboPartyPlan(message, stats, args.slice(1));
  try {
    const window = parseWindow(args);
    const enemyByMatch = turboRankService.getEnemyStrengthByMatch({ registeredOnly: true, minVisibleEnemies: 2 });
    const { parties, pairGames, steamIds, names, scoredTeams } = stats.getPartyRecords(enemyByMatch, MIN_PARTY_GAMES, window.sinceTimestamp);
    const { players } = stats.getPullRatings(enemyByMatch, 20, window.sinceTimestamp);
    const pullById = new Map(players.map(player => [player.discordId, player]));

    const lockedIds = [...message.mentions.users.keys()];
    if (args.some(arg => ['me', 'my', 'mine'].includes(arg.toLowerCase())) && !lockedIds.includes(message.author.id)) {
      lockedIds.unshift(message.author.id);
    }
    if (lockedIds.length > 5) return message.reply('A party is five players — name up to 5.');

    const nameCache = new Map<string, string>();
    const nameOf = async (id: string) => {
      if (!nameCache.has(id)) nameCache.set(id, names.get(id) || await displayName(message, { discordId: id, steamId: steamIds.get(id) || '' }));
      return nameCache.get(id)!;
    };
    const namesOf = async (ids: string[]) => (await Promise.all(ids.map(async id => {
      const name = await nameOf(id);
      return lockedIds.includes(id) ? name : `**${name}**`;
    }))).join(' · ');
    const mmrText = (mmr: number) => `**${mmrToMedal(mmr).medal}** (${Math.round(mmr)})`;
    const pairsSeen = (ids: string[]) => {
      let seen = 0;
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        if ((pairGames.get([ids[i], ids[j]].sort().join(':')) || 0) >= 3) seen++;
      }
      return seen;
    };

    // Ranks are server-wide, so a named party's rows keep the place they hold on the full board.
    const withLocked = (list: typeof parties) => list.filter(party => lockedIds.every(id => party.playerIds.includes(id)));
    const allFives = parties.filter(party => party.playerIds.length === 5);
    const allCores = parties.filter(party => party.playerIds.length < 5);
    const fives = withLocked(allFives).slice(0, MAX_ROWS);
    const cores = fives.length < 3 ? withLocked(allCores).slice(0, 3) : [];
    const medals = ['🥇', '🥈', '🥉'];
    const recordLine = (board: typeof parties) => async (party: typeof parties[number]) => {
      const rank = board.indexOf(party);
      const winRate = Math.round((party.wins / party.games) * 100);
      return `${medals[rank] || `**#${rank + 1}**`} ${await namesOf(party.playerIds)}\n`
        + `Party MMR ${mmrText(party.score)}, ${party.playDays >= 3 ? `likely ${Math.round(party.low)}–${Math.round(party.high)}` : `only ${party.playDays} play day${party.playDays === 1 ? '' : 's'}, range unknown`} · `
        + `${party.wins}–${party.losses} (${winRate}%) vs ${mmrToMedal(party.enemyMMR).medal} enemies`;
    };

    // Potential stacks: the strongest five-stacks around the named players that haven't played 10 games together.
    const potentialLines: string[] = [];
    const unrated = lockedIds.filter(id => !pullById.has(id));
    if (!unrated.length) {
      const activeSince = Math.floor(Date.now() / 1000) - ACTIVE_DAYS * 86400;
      const pool = players
        .filter(player => !lockedIds.includes(player.discordId) && player.lastPlayed >= activeSince)
        .sort((a, b) => b.rating - a.rating)
        .slice(0, POTENTIAL_POOL);
      const proven = new Set(parties.filter(party => party.playerIds.length === 5).map(party => party.playerIds.join(',')));
      const locked = lockedIds.map(id => pullById.get(id)!);
      const candidates = combinations(pool, 5 - locked.length)
        .map(fill => [...locked, ...fill])
        .map(party => ({
          ids: party.map(player => player.discordId).sort(),
          rating: party.reduce((sum, player) => sum + player.rating, 0) / party.length
        }))
        .filter(party => !proven.has(party.ids.join(',')))
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 3);
      for (const party of candidates) {
        potentialLines.push(`${await namesOf(party.ids)}\n~${mmrText(party.rating)} · ${pairsSeen(party.ids)}/10 pairs have played together`);
      }
    }

    const lockedNames = await Promise.all(lockedIds.map(nameOf));
    const embed = new EmbedBuilder()
      .setColor('#8b5cf6')
      .setTitle(lockedIds.length ? `🧩 Turbo Parties — ${lockedNames.join(' + ')}` : '🧩 Most Successful Turbo Parties')
      .setDescription(
        '**How strong each stack plays together: the rank of the enemies it faces, nudged up for wins and down for losses.** '
        + 'Matchmaking keeps every regular stack near 50%, so the enemy level counts most: winning a bit more against '
        + `Divines beats winning a lot against Legends. From ${scoredTeams} of our own games (${window.label}).\n`
        + '`+turboparty me` or `+turboparty @a @b` shows the stacks with those players. `+turboparty plan` plans easy or tough lobbies.'
      )
      .setFooter({ text: 'Small stacks are pulled toward the server average · likely = 90% range over play days · unregistered friends count once they have 10+ games with us' })
      .setTimestamp();

    // Discord caps a field at 1024 characters, so the board is split across fields as it fills.
    const fiveLines = await Promise.all(fives.map(recordLine(allFives)));
    const chunks: string[][] = [];
    for (const line of fiveLines) {
      const last = chunks[chunks.length - 1];
      if (last && [...last, line].join('\n').length <= 1024) last.push(line);
      else chunks.push([line]);
    }
    chunks.forEach((chunk, i) => embed.addFields({
      name: i ? '\u200b' : `🏆 Party leaderboard: five-stacks with ${MIN_PARTY_GAMES}+ games (${allFives.length} on the board)`,
      value: chunk.join('\n')
    }));
    if (cores.length) {
      embed.addFields({
        name: fives.length ? '🧱 Best cores (3–4 tracked players)' : `🧱 No five-stack has ${MIN_PARTY_GAMES}+ games yet — best cores`,
        value: (await Promise.all(cores.map(recordLine(allCores)))).join('\n')
      });
    }
    if (!fives.length && !cores.length) {
      embed.addFields({ name: '🏆 Proven parties', value: `No stack${lockedIds.length ? ' with them' : ''} has ${MIN_PARTY_GAMES}+ rank-scored games together in ${window.label}.` });
    }
    embed.addFields({
      name: '🔮 Potential five-stacks (not played together enough yet)',
      value: unrated.length
        ? `No pull rating yet for ${(await Promise.all(unrated.map(nameOf))).join(', ')}: they need 20+ rank-scored games.`
        : potentialLines.length
          ? `${potentialLines.join('\n')}\n_Rated on each player's own level. Pair history didn't predict results in testing, so it isn't scored._`
          : `Not enough players active in the last ${ACTIVE_DAYS} days to fill one.`
    });
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo party board:', error);
    return message.reply('An error occurred while ranking Turbo parties. Please try again later.');
  }
}
