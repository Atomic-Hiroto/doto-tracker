import { Message, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { APIConstants, Replies } from '../constants';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { parseArgs, parseIntArg } from '../utils/argParser';
import { safeTyping } from '../utils/channelHelpers';
import { createMatchPickerRows } from '../components/matchButtons';
import { renderRecentMatchesTableWithIcons, MatchRow } from '../services/chartService';
import { applyResidualFilters, parseMatchFilter, queryString } from '../utils/matchFilter';

const GAME_MODES: Record<number, string> = {
  0: 'Unknown', 1: 'All Pick', 2: 'Captains Mode', 3: 'Random Draft',
  4: 'Single Draft', 5: 'All Random', 8: 'Reverse Captains Mode',
  16: 'Captains Draft', 22: 'All Draft', 23: 'Turbo', 24: 'Mutation',
};

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
  if (!user) return message.reply(Replies.NEED_REGISTRATION);

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

    const tableRows: MatchRow[] = await Promise.all(
      list.map(async (m: any) => {
        const heroName = await getHero(m.hero_id);
        const isRadiant = m.player_slot < 128;
        const won = (isRadiant && m.radiant_win) || (!isRadiant && !m.radiant_win);
        return {
          won,
          hero: heroName,
          heroImageUrl: APIConstants.IMAGE_URL(heroName),
          kills: m.kills,
          deaths: m.deaths,
          assists: m.assists,
          gpm: m.gold_per_min,
          durationSec: m.duration,
          mode: GAME_MODES[m.game_mode] || 'Unknown',
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
      .setImage('attachment://matches.png')
      .setFooter({ text: '🟢 win  🔴 loss  •  numbers match the rows above' });

    const pickerRows = createMatchPickerRows(list.map((m: any) => ({ matchId: m.match_id, won: (m.player_slot < 128) === m.radiant_win })));

    await message.reply({ embeds: [embed], files: [attachment], components: pickerRows });
  } catch (error) {
    logger.error(`Error in matches command for user ${discordId}:`, error);
    await message.reply('An error occurred while fetching matches. Please try again later.');
  }
}
