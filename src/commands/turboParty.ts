import { EmbedBuilder, Message } from 'discord.js';
import { TurboStatsService } from '../services/turboStatsService';
import { turboRankService, mmrToMedal } from '../services/turboRankService';
import { logger } from '../services/loggerService';
import { displayName, parseWindow } from './turboPull';
import { winRateText } from './turboPairings';

const ACTIVE_DAYS = 60;
const MIN_PARTY_GAMES = 10;
const MAX_ROWS = 10;
/** `wins` mode pulls each record this many games toward 50%, so 8–2 beats 3–0 but not 30–10. */
const WIN_PRIOR_GAMES = 10;
const WINS_ARGS = ['wins', 'win', 'winrate', 'wr'];
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
 * `+turboparty [@user ...|me] [days]` — the strongest Turbo stacks on the server.
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
 *
 * `+turboparty wins` ranks the same stacks by win rate instead, pulled toward 50% by
 * WIN_PRIOR_GAMES. That board is mostly luck (stack records didn't repeat in forward tests), so it
 * carries the same ± luck range and note as `+turbopairs`, and skips potential stacks, which have
 * no record.
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
    const byWins = args.some(arg => WINS_ARGS.includes(arg.toLowerCase()));

    const nameCache = new Map<string, string>();
    const nameOf = async (id: string) => {
      if (!nameCache.has(id)) nameCache.set(id, names.get(id) || await displayName(message, { discordId: id, steamId: steamIds.get(id) || '' }));
      return nameCache.get(id)!;
    };
    // The players asked about stand out in bold; on the full board every name is plain.
    const namesOf = async (ids: string[]) => (await Promise.all(ids.map(async id => {
      const name = await nameOf(id);
      return lockedIds.includes(id) ? `**${name}**` : name;
    }))).join(' · ');
    const mmrText = (mmr: number) => `**${mmrToMedal(mmr).medal}** · ${Math.round(mmr)}`;
    const pairsSeen = (ids: string[]) => {
      let seen = 0;
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        if ((pairGames.get([ids[i], ids[j]].sort().join(':')) || 0) >= 3) seen++;
      }
      return seen;
    };

    const shrunkWinRate = (party: typeof parties[number]) => (party.wins + WIN_PRIOR_GAMES / 2) / (party.games + WIN_PRIOR_GAMES);
    const board = byWins
      ? [...parties].sort((a, b) => shrunkWinRate(b) - shrunkWinRate(a) || b.games - a.games)
      : parties;

    // Ranks are server-wide, so a named party's rows keep the place they hold on the full board.
    const withLocked = (list: typeof parties) => list.filter(party => lockedIds.every(id => party.playerIds.includes(id)));
    const allFives = board.filter(party => party.playerIds.length === 5);
    const allCores = board.filter(party => party.playerIds.length < 5);
    const fives = withLocked(allFives).slice(0, MAX_ROWS);
    const cores = fives.length < 3 ? withLocked(allCores).slice(0, 3) : [];
    const medals = ['🥇', '🥈', '🥉'];
    // Each row leads with what the board is ranked by, then the players, then the other measure.
    const recordLine = (list: typeof parties) => async (party: typeof parties[number]) => {
      const rank = list.indexOf(party);
      const place = medals[rank] || `\`#${rank + 1}\``;
      const range = party.playDays >= 3
        ? `likely ${Math.round(party.low)}–${Math.round(party.high)}`
        : `range unknown (${party.playDays} play day${party.playDays === 1 ? '' : 's'})`;
      const enemies = `faced ${mmrToMedal(party.enemyMMR).medal} enemies`;
      if (byWins) {
        return `${place} ${winRateText(party.wins, party.games)} · ${party.wins}W–${party.losses}L\n`
          + `${await namesOf(party.playerIds)}\n`
          + `Party MMR ${mmrText(party.score)} · ${enemies}`;
      }
      const winRate = Math.round((party.wins / party.games) * 100);
      return `${place} ${mmrText(party.score)} · ${range}\n`
        + `${await namesOf(party.playerIds)}\n`
        + `${party.wins}W–${party.losses}L (${winRate}%) · ${enemies}`;
    };

    // Potential stacks: the strongest five-stacks around the named players that haven't played 10 games together.
    const potentialLines: string[] = [];
    const unrated = lockedIds.filter(id => !pullById.has(id));
    if (!unrated.length && !byWins) {
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
        potentialLines.push(`🔹 ~${mmrText(party.rating)} · ${pairsSeen(party.ids)}/10 pairs have played together\n${await namesOf(party.ids)}`);
      }
    }

    const lockedNames = await Promise.all(lockedIds.map(nameOf));
    const embed = new EmbedBuilder()
      .setColor('#8b5cf6')
      .setTitle(lockedIds.length
        ? `🧩 Turbo Stacks — ${lockedNames.join(' + ')}${byWins ? ' · by win rate' : ''}`
        : byWins ? '🍀 Winningest Turbo Stacks' : '🧩 Strongest Turbo Stacks')
      .setDescription(byWins
        ? '**Ranked by win rate**, pulled 10 games toward 50% so a short hot streak can\'t top it. '
          + '🍀 Mostly luck: ± is how far a lucky or unlucky run alone could push it, and stack records '
          + 'didn\'t repeat when we checked later games.\n'
          + `-# ${scoredTeams} of our games · ${window.label}\n\n`
          + '`+turboparty` ranks by Party MMR instead · `+turboparty plan` for easy or tough lobbies'
        : '**Party MMR** is the rank of the enemies a stack draws, plus a small bump per win and a dip per loss. '
          + 'Matchmaking keeps regular stacks near 50%, so the enemy level counts most.\n'
          + `-# ${scoredTeams} of our games · ${window.label}\n\n`
          + '`+turboparty me` · `+turboparty @a @b` · `+turboparty wins` · `+turboparty plan` for easy or tough lobbies')
      .setFooter({
        text: byWins
          ? '± = 95% range luck allows at that many games · unregistered friends count after 10+ games with us'
          : 'Few-game stacks are pulled toward the server average · likely = 90% range over play days · unregistered friends count after 10+ games with us'
      })
      .setTimestamp();

    // Discord caps a field at 1024 characters, so the board is split across fields as it fills.
    // A blank line between rows keeps each three-line entry readable.
    const fiveLines = await Promise.all(fives.map(recordLine(allFives)));
    const chunks: string[][] = [];
    for (const line of fiveLines) {
      const last = chunks[chunks.length - 1];
      if (last && [...last, line].join('\n\n').length <= 1024) last.push(line);
      else chunks.push([line]);
    }
    chunks.forEach((chunk, i) => embed.addFields({
      name: i ? '\u200b' : `🏆 Five-stacks with ${MIN_PARTY_GAMES}+ games together · ${allFives.length} on the board`,
      value: chunk.join('\n\n')
    }));
    if (cores.length) {
      embed.addFields({
        name: fives.length ? '🧱 Best cores (3–4 tracked players)' : `🧱 No five-stack has ${MIN_PARTY_GAMES}+ games yet — best cores`,
        value: (await Promise.all(cores.map(recordLine(allCores)))).join('\n\n')
      });
    }
    if (!fives.length && !cores.length) {
      embed.addFields({ name: '🏆 Proven parties', value: `No stack${lockedIds.length ? ' with them' : ''} has ${MIN_PARTY_GAMES}+ rank-scored games together in ${window.label}.` });
    }
    if (!byWins) {
      embed.addFields({
        name: '🔮 Potential five-stacks · not played together enough yet',
        value: unrated.length
          ? `No pull rating yet for ${(await Promise.all(unrated.map(nameOf))).join(', ')}: they need 20+ rank-scored games.`
          : potentialLines.length
            ? `${potentialLines.join('\n\n')}\n-# Rated on each player's own level. Pair history didn't predict results in testing, so it isn't scored.`
            : `Not enough players active in the last ${ACTIVE_DAYS} days to fill one.`
      });
    }
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo party board:', error);
    return message.reply('An error occurred while ranking Turbo parties. Please try again later.');
  }
}
