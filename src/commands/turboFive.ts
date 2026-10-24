import { EmbedBuilder, Message } from 'discord.js';
import { STRATZ_API_KEY } from '../constants/process';
import { TurboStatsService } from '../services/turboStatsService';
import { UserDataService } from '../services/userDataService';
import { turboRankService, mmrToMedal } from '../services/turboRankService';
import { fetchPlayerTurboRoles } from '../services/stratzClient';
import { assignRoles, buildRoleTable, MIN_HERO_GAMES, RoleTable } from '../services/turboFiveService';
import { dotaDataService } from '../services/dotaDataService';
import { logger } from '../services/loggerService';
import { safeFields } from '../utils/embedFields';
import { displayName, parseWindow } from './turboPull';

const ACTIVE_DAYS = 60;
/** Games with you before someone is considered for an open slot. */
const MIN_DUO_GAMES = 3;
/** Duo records with you are pulled this many games toward 50%, the same prior `+turbopairs` uses. */
const DUO_PRIOR_GAMES = 20;
/** Teammates considered for open slots, best duo record with you first. C(12, 4) = 495 lineups. */
const POOL_SIZE = 12;
/** Lineups whose positions and heroes are worked out; the rest can't catch up on role fit alone. */
const ROLE_CANDIDATES = 6;
/** Hero and position history read per player. */
const ROLE_GAMES = 200;
/**
 * Party MMR is a small nudge on top of win rate: every 400 MMR of pull above the crew average is
 * worth one point of win rate, about two points per medal. Enough that four players who only win
 * in easy lobbies don't take the slots, not enough to outvote a real record together.
 */
const MMR_PER_WIN_POINT = 400;
/** How much the lineup's hero-at-position fit counts next to its win rate. */
const ROLE_WEIGHT = 0.5;
const POSITION_NAMES = ['', 'Safelane', 'Mid', 'Offlane', 'Soft Sup', 'Hard Sup'];
const record = (wins: number, games: number) => `${wins}W–${games - wins}L`;
const pct = (rate: number) => Math.round(rate * 100);

/**
 * `+turbofive [@user ...] [days]` — your best Turbo five-stack, with a position and hero for everyone.
 *
 * Name nobody and it fills four slots; name some and it fills the rest; name four and it only slots
 * that party. A lineup's win rate is half your own duo record with each of the other four and half
 * `recommendParties` (every member's record, every pair, and the exact five when it has played),
 * nudged by Party MMR from the `+turbopull` ratings. The top few are then slotted into positions
 * from each player's recent Stratz games: no two players share a position or a hero, and a clash
 * goes to whichever choice leaves the party better off.
 */
export async function turboFive(message: Message, args: string[], users: UserDataService, stats: TurboStatsService) {
  try {
    const me = users.getUserByDiscordId(message.author.id);
    if (!me) return message.reply('Register first with `+register <steam id>` so I know whose party this is.');

    const named = [...message.mentions.users.values()].filter(user => !user.bot && user.id !== me.discordId);
    if (named.length > 4) return message.reply('A party is five players — name up to 4 others.');
    const unregistered = named.filter(user => !users.getUserByDiscordId(user.id));
    if (unregistered.length) {
      return message.reply(`**${unregistered.map(user => user.username).join(', ')}** ${unregistered.length === 1 ? 'isn\'t' : 'aren\'t'} registered, so I have no Turbo record for them.`);
    }

    const window = parseWindow(args);
    const lockedIds = [me.discordId, ...named.map(user => user.id)];
    const steamOf = new Map(users.getAllUsers().map(user => [user.discordId, user.steamId]));

    // Open slots go to people you actually play with, best record with you first.
    const duoWithMe = new Map(stats.getPairingsForPlayer(me.discordId, 'all', window.sinceTimestamp)
      .map(pair => [pair.player1 === me.discordId ? pair.player2 : pair.player1, pair]));
    const duoRate = (id: string) => {
      const pair = duoWithMe.get(id);
      return ((pair?.wins || 0) + DUO_PRIOR_GAMES / 2) / ((pair ? pair.wins + pair.losses : 0) + DUO_PRIOR_GAMES);
    };
    const activeSince = Date.now() - ACTIVE_DAYS * 86400_000;
    const need = 5 - lockedIds.length;
    const pool = need === 0 ? [] : [...duoWithMe.entries()]
      .filter(([id, pair]) => !lockedIds.includes(id) && steamOf.has(id) && pair.wins + pair.losses >= MIN_DUO_GAMES)
      .filter(([id]) => (stats.getPlayerStats(id)?.lastUpdated ?? 0) >= activeSince)
      .sort(([a], [b]) => duoRate(b) - duoRate(a))
      .slice(0, POOL_SIZE)
      .map(([id]) => id);
    if (pool.length < need) {
      return message.reply(
        `Only ${pool.length} active player${pool.length === 1 ? ' has' : 's have'} ${MIN_DUO_GAMES}+ Turbo games with you in ${window.label}, `
        + `not enough to fill ${need} slot${need === 1 ? '' : 's'}. Name the rest yourself: \`+turbofive @a @b …\`.`
      );
    }

    const lineups = stats.recommendParties([...lockedIds, ...pool], 'all', Number.MAX_SAFE_INTEGER, window.sinceTimestamp, lockedIds, 0);
    if (!lineups.length) return message.reply('I couldn\'t build a lineup from those players. Please try again later.');

    // Party MMR from the +turbopull ratings; anyone without one counts as the crew average.
    const enemyByMatch = turboRankService.getEnemyStrengthByMatch({ registeredOnly: true, minVisibleEnemies: 2 });
    const { players: pullPlayers } = stats.getPullRatings(enemyByMatch, 20, window.sinceTimestamp);
    const pullById = new Map(pullPlayers.map(player => [player.discordId, player.rating]));
    const crewPull = pullPlayers.length ? pullPlayers.reduce((sum, player) => sum + player.rating, 0) / pullPlayers.length : 0;
    const partyPull = (ids: string[]) => ids.reduce((sum, id) => sum + (pullById.get(id) ?? crewPull), 0) / ids.length;

    const scored = lineups
      .map(lineup => {
        const pull = partyPull(lineup.playerIds);
        const others = lineup.playerIds.filter(id => id !== me.discordId);
        const withYou = others.reduce((sum, id) => sum + duoRate(id), 0) / others.length;
        const winRate = (lineup.predictedWinRate + withYou) / 2;
        return { lineup, pull, withYou, winRate, base: winRate + (pull - crewPull) / MMR_PER_WIN_POINT / 100 };
      })
      .sort((a, b) => b.base - a.base)
      .slice(0, ROLE_CANDIDATES);

    const toFetch = [...new Set(scored.flatMap(entry => entry.lineup.playerIds))];
    const progress = await message.reply(STRATZ_API_KEY
      ? `🔎 Reading hero and position history for ${toFetch.length} players…`
      : '🔎 Building your party…');
    const tables = new Map<string, RoleTable>();
    const historyGames = new Map<string, number>();
    for (let i = 0; i < toFetch.length; i += 3) {
      await Promise.all(toFetch.slice(i, i + 3).map(async id => {
        const games = await fetchPlayerTurboRoles(Number(steamOf.get(id)), ROLE_GAMES);
        tables.set(id, buildRoleTable(games));
        historyGames.set(id, games.length);
      }));
    }

    // Stronger players are passed first, so a perfectly tied slot goes to them.
    const strength = (id: string) => pullById.get(id) ?? crewPull;
    const finalists = scored
      .map(entry => {
        const ordered = [...entry.lineup.playerIds].sort((a, b) => strength(b) - strength(a));
        const roles = assignRoles(ordered.map(id => ({ id, table: tables.get(id)! })));
        return roles ? { ...entry, roles, total: entry.base + ROLE_WEIGHT * (roles.fit - 0.5) } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.total - a.total);
    const best = finalists[0];
    if (!best) return progress.edit('I couldn\'t slot that party into positions. Please try again later.');

    const names = new Map<string, string>();
    for (const id of toFetch) names.set(id, await displayName(message, { discordId: id, steamId: steamOf.get(id) || '' }));
    const nameOf = (id: string) => `**${names.get(id)}**${id === me.discordId ? ' (you)' : lockedIds.includes(id) ? ' 📌' : ''}`;

    // One block per player with a blank line between them: Discord's small-print `-#` lines run
    // into the next row, so the detail goes on a plain second line instead.
    const rows = await Promise.all(best.roles.slots.map(async slot => {
      const hero = slot.heroId !== null ? await dotaDataService.getHeroName(slot.heroId) : null;
      const pos = `pos ${slot.position}`;
      const details: string[] = [];
      if (!historyGames.get(slot.playerId)) {
        details.push('no Stratz history');
      } else {
        if (hero) details.push(`${record(slot.wins, slot.games)} on ${hero} at ${pos}`);
        else details.push(`no hero with ${MIN_HERO_GAMES}+ games at ${pos}${slot.games ? ` · ${record(slot.wins, slot.games)} there` : ''}`);
        details.push(`${pct(slot.positionShare)}% of their games at ${pos}`);
      }
      if (slot.playerId !== me.discordId) {
        const duo = duoWithMe.get(slot.playerId);
        details.push(duo ? `${record(duo.wins, duo.wins + duo.losses)} with you` : 'never with you');
      }
      return `**${slot.position} · ${POSITION_NAMES[slot.position]}** — ${nameOf(slot.playerId)} on **${hero ?? 'any hero'}**\n${details.join(' · ')}`;
    }));

    const { lineup, pull, withYou } = best;
    const exact = lineup.exactLineupGames
      ? `${record(lineup.exactLineupWins, lineup.exactLineupGames)} as this exact five`
      : 'never queued as this exact five';
    // Without any pull ratings every party sits at the same made-up average, so say nothing about MMR.
    const enemies = pullPlayers.length ? ` · draws **${mmrToMedal(pull).medal}** enemies (~${Math.round(pull)} MMR)` : '';
    const summary = `**${pct(best.winRate)}%** expected · **${pct(withYou)}%** with you on average${enemies}\n`
      + `${exact} · ${lineup.coveredPairs}/10 pairs have 5+ games together`;
    const how = need
      ? `Filled ${need} slot${need === 1 ? '' : 's'} from ${pool.length} players with ${MIN_DUO_GAMES}+ games with you: your record with them, how the five do together, a nudge for Party MMR, and how well they fit the positions. `
      : '';
    const description = `${summary}\n\n${how}Everyone gets a different position and hero: heroes they've played ${MIN_HERO_GAMES}+ times there, favouring the positions they play most. 📌 = named by you.`
      + (STRATZ_API_KEY ? '' : '\n⚠️ Stratz isn\'t configured, so positions are a guess.');

    const fields = [{ name: '🖐️ Lineup', value: rows.join('\n\n') }];
    const others = finalists.slice(1, 3);
    if (need && others.length) {
      fields.push({
        name: 'Close behind',
        value: others.map(entry => `${pct(entry.winRate)}% expected · ${pct(entry.withYou)}% with you — `
          + entry.lineup.playerIds.filter(id => id !== me.discordId).map(id => names.get(id)).join(' · ')).join('\n')
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#8b5cf6')
      .setTitle(`🖐️ Turbo Five — ${lockedIds.map(id => names.get(id)).join(' + ')}`.slice(0, 256))
      .setDescription(description)
      .addFields(safeFields(fields, description.length + 100))
      .setFooter({ text: `Heroes from each player's last ${ROLE_GAMES} Turbo games (Stratz) · records pulled toward 50% · pair records from ${window.label}` })
      .setTimestamp();
    return progress.edit({ content: '', embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo five:', error);
    return message.reply('An error occurred while building your Turbo five. Please try again later.');
  }
}
