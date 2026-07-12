import { Message, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { APIConstants, Replies } from '../constants';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { parseArgs, parseIntArg } from '../utils/argParser';
import { safeTyping } from '../utils/channelHelpers';
import { createMatchPickerRows } from '../components/matchButtons';
import { renderRecentMatchesTableWithIcons, MatchRow, MatchBadge } from '../services/chartService';
import { applyResidualFilters, parseMatchFilter, queryString } from '../utils/matchFilter';
import { formatRankLabel } from '../services/rankDisplayService';

const GAME_MODES: Record<number, string> = {
  0: 'Unknown', 1: 'All Pick', 2: 'Captains Mode', 3: 'Random Draft',
  4: 'Single Draft', 5: 'All Random', 8: 'Reverse Captains Mode',
  16: 'Captains Draft', 22: 'All Draft', 23: 'Turbo', 24: 'Mutation',
};

// Per-game leader awards: did this player top all 10 players in the match for a
// given stat. hero_damage/tower_damage/hero_healing come from the base match
// details; damage_taken only exists on parsed matches, so TANK is best-effort.
function computeMatchBadges(match: any, playerSlot: number): MatchBadge[] {
  const players = Array.isArray(match?.players) ? match.players : [];
  if (players.length < 2) return [];
  const me = players.find((p: any) => Number(p.player_slot) === Number(playerSlot));
  if (!me) return [];

  const badges: MatchBadge[] = [];
  const leads = (field: string): boolean => {
    const mine = Number(me[field] ?? 0);
    return mine > 0 && players.every((p: any) => Number(p[field] ?? 0) <= mine);
  };
  if (leads('hero_damage')) badges.push('dmg');
  if (leads('tower_damage')) badges.push('twr');
  if (leads('hero_healing')) badges.push('heal');

  const takenOf = (p: any): number | null => {
    const v = p?.damage_taken;
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'object') return Object.values(v).reduce((sum: number, n: any) => sum + Number(n || 0), 0);
    return null;
  };
  const takens = players.map(takenOf);
  const myTaken = takenOf(me);
  if (myTaken != null && myTaken > 0 && takens.every((t: number | null) => t != null && t <= myTaken)) {
    badges.push('tank');
  }
  return badges;
}

// +matches [@user] [n] [filters] — lists recent matches as an image table with
// numbered pick buttons. Picking a number opens that match with Analyze /
// Analyze me / Details / OpenDota / Stratz actions (handled in interactionService).
export async function matches(message: Message, args: string[], userDataService: UserDataService) {
  const parsed = parseArgs(args, message);

  let discordId = message.author.id;
  let targetUser = message.author;
  if (parsed.mentions.length > 0) {
    discordId = parsed.mentions[0];
    targetUser = message.mentions.users.first()!;
  }

  const user = userDataService.getUserByDiscordId(discordId);
  if (!user) return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));

  const countArg = parsed.positional[0] && /^\d+$/.test(parsed.positional[0]) ? parsed.positional[0] : undefined;
  const count = Math.min(parseIntArg(countArg, 10), 10);
  const filterWords = countArg ? parsed.positional.slice(1) : parsed.positional.slice();

  try {
    safeTyping(message.channel);
    const filter = await parseMatchFilter(filterWords, message, userDataService);

    const fetchCount = filter.consumedAny ? Math.max(50, count * 5) : count;
    const endpoint = filter.consumedAny
      ? `/players/${user.steamId}/matches${queryString({ ...filter.openDotaParams, limit: fetchCount, significant: 0 })}`
      : `/players/${user.steamId}/recentMatches?limit=${fetchCount}`;
    const response = await opendotaClient.get<Array<any>>(endpoint);
    let list = applyResidualFilters(response.data || [], filter).slice(0, count);

    if (list.length === 0) {
      return message.reply(filter.consumedAny ? 'No matches found with those filters.' : 'No recent matches found for this user.');
    }

    const heroCache: Record<number, string> = {};
    const getHero = async (id: number) => {
      if (!heroCache[id]) heroCache[id] = await dotaDataService.getHeroName(id);
      return heroCache[id];
    };

    // Best-effort per-game leader badges: pull full details for the listed matches
    // in parallel and flag where this player topped all 10. Never blocks the table —
    // a failed fetch just leaves that row without badges.
    const badgesByMatch: Record<number, MatchBadge[]> = {};
    const details = await Promise.all(
      list.map((m: any) => opendotaClient.get<any>(`/matches/${m.match_id}`).then((r) => r.data).catch(() => null))
    );
    list.forEach((m: any, idx: number) => {
      if (details[idx]) badgesByMatch[m.match_id] = computeMatchBadges(details[idx], m.player_slot);
    });

    const tableRows: MatchRow[] = await Promise.all(
      list.map(async (m: any) => {
        const heroName = await getHero(m.hero_id);
        const isRadiant = m.player_slot < 128;
        const won = (isRadiant && m.radiant_win) || (!isRadiant && !m.radiant_win);
        return {
          won,
          hero: heroName,
          heroImageUrl: APIConstants.IMAGE_URL(heroName),
          rankLabel: formatRankLabel(Number(m.average_rank || 0)) ?? undefined,
          kills: m.kills,
          deaths: m.deaths,
          assists: m.assists,
          gpm: m.gold_per_min,
          durationSec: m.duration,
          mode: GAME_MODES[m.game_mode] || 'Unknown',
          badges: badgesByMatch[m.match_id]?.length ? badgesByMatch[m.match_id] : undefined,
        };
      })
    );

    const wins = tableRows.filter((r) => r.won).length;
    const filterDesc = filter.descriptionParts.length ? filter.descriptionParts.join(' • ') : undefined;

    const tableImage = await renderRecentMatchesTableWithIcons(tableRows, {
      username: targetUser.username,
      wins,
      total: tableRows.length,
      subtitle: filterDesc,
    });
    const attachment = new AttachmentBuilder(tableImage, { name: 'matches.png' });

    const embed = new EmbedBuilder()
      .setColor('#7c3aed')
      .setTitle(`🎯 Pick a match — ${targetUser.username}`)
      .setDescription('Tap a number below to open that match for analysis, details and links.')
      .setImage('attachment://matches.png');

    const anyBadges = tableRows.some((r) => r.badges?.length);
    embed.setFooter({
      text: anyBadges
        ? '🟢 win  🔴 loss  •  🏅 game-leader: DMG hero dmg · TWR building · HEAL healing · TANK dmg taken'
        : '🟢 win  🔴 loss  •  numbers match the rows above',
    });

    const pickerRows = createMatchPickerRows(list.map((m: any) => ({ matchId: m.match_id, won: (m.player_slot < 128) === m.radiant_win })));

    await message.reply({ embeds: [embed], files: [attachment], components: pickerRows });
  } catch (error) {
    logger.error(`Error in matches command for user ${discordId}:`, error);
    await message.reply('An error occurred while fetching matches. Please try again later.');
  }
}
