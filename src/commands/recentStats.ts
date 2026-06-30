import { Message, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { APIConstants, Replies } from '../constants';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { parseArgs, parseIntArg } from '../utils/argParser';
import { formatDuration } from '../utils/formatters';
import { safeTyping } from '../utils/channelHelpers';
import { createMatchActionRow } from '../components/matchButtons';
import { renderRecentMatchesTableWithIcons, renderScoreboardFromMatch, MatchRow } from '../services/chartService';
import { applyResidualFilters, parseMatchFilter, queryString } from '../utils/matchFilter';
import { formatRankLabel } from '../services/rankDisplayService';

const GAME_MODES: Record<number, string> = {
  0: 'Unknown', 1: 'All Pick', 2: 'Captains Mode', 3: 'Random Draft',
  4: 'Single Draft', 5: 'All Random', 8: 'Reverse Captains Mode',
  16: 'Captains Draft', 22: 'All Draft', 23: 'Turbo', 24: 'Mutation'
};

export async function recentStats(message: Message, args: string[], userDataService: UserDataService) {
  const parsed = parseArgs(args, message);

  // Determine target user
  let discordId = message.author.id;
  let targetUser = message.author;
  if (parsed.mentions.length > 0) {
    discordId = parsed.mentions[0];
    targetUser = message.mentions.users.first()!;
  }

  const user = userDataService.getUserByDiscordId(discordId);
  if (!user) {
    return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));
  }

  // Parse count arg — +rs 5 or default 1. Keep the remaining words for the filter DSL.
  const countArg = parsed.positional[0] && /^\d+$/.test(parsed.positional[0]) ? parsed.positional[0] : undefined;
  const count = Math.min(parseIntArg(countArg, 1), 10);
  const detailTokens = new Set(['detail', 'details', 'detailed', 'full', 'scorecard']);
  const rawFilterWords = countArg ? parsed.positional.slice(1) : parsed.positional.slice();
  const detailedView = rawFilterWords.some((word) => detailTokens.has(word.toLowerCase()));
  const filterWords = rawFilterWords.filter((word) => !detailTokens.has(word.toLowerCase()));
  const heroFilter = typeof parsed.flags['hero'] === 'string' ? parsed.flags['hero'].toLowerCase() : null;
  const turboOnly = parsed.flags['turbo'] === true;
  const winsOnly = parsed.flags['wins'] === true;
  const lossesOnly = parsed.flags['losses'] === true;
  if (heroFilter) filterWords.push('as', heroFilter);
  if (turboOnly) filterWords.push('turbo');
  if (winsOnly) filterWords.push('won');
  if (lossesOnly) filterWords.push('lost');

  try {
    safeTyping(message.channel);
    const filter = await parseMatchFilter(filterWords, message, userDataService);

    const fetchCount = filter.consumedAny ? Math.max(50, count * 5) : count;
    const endpoint = filter.consumedAny
      ? `/players/${user.steamId}/matches${queryString({ ...filter.openDotaParams, limit: fetchCount, significant: 0 })}`
      : `/players/${user.steamId}/recentMatches?limit=${fetchCount}`;
    const response = await opendotaClient.get<Array<any>>(endpoint);
    let matches = applyResidualFilters(response.data || [], filter);

    if (matches.length === 0) {
      return message.reply(filter.consumedAny ? 'No matches found with those filters.' : 'No recent matches found for this user.');
    }

    matches = matches.slice(0, count);

    // Single match — show detailed stats
    if (count === 1) {
      const match = matches[0];
      const heroName = await dotaDataService.getHeroName(match.hero_id);
      const isRadiant = match.player_slot < 128;
      const didWin = (isRadiant && match.radiant_win) || (!isRadiant && !match.radiant_win);
      const files: AttachmentBuilder[] = [];
      let hasBoard = false;

      try {
        const { data: detailedMatch } = await opendotaClient.get<any>(`/matches/${match.match_id}`);
        if (detailedMatch?.players?.length) {
          const board = await renderScoreboardFromMatch(detailedMatch, [user.steamId], undefined, { detailed: detailedView });
          files.push(new AttachmentBuilder(board, { name: 'scoreboard.png' }));
          hasBoard = true;
        }
      } catch (boardError) {
        logger.warn(`Could not render +rs scoreboard for match ${match.match_id}:`, boardError);
      }

      const embed = new EmbedBuilder()
        .setColor(didWin ? '#66bb6a' : '#ef5350')
        .setTitle(`Recent Match — ${targetUser.username}`)
        .setDescription(`**${didWin ? '✅ Victory' : '❌ Defeat'}** as **${heroName}**`)
        .setURL(`https://www.opendota.com/matches/${match.match_id}`)
        .setTimestamp(new Date(match.start_time * 1000));

      if (hasBoard) {
        embed
          .setImage('attachment://scoreboard.png')
          .setFooter({
            text: detailedView
              ? 'Detailed scorecard: G/X, net/LH/DN, hero/tower damage, healing, stun duration. Ranks shown when visible.'
              : 'Ranks shown when visible from STRATZ/OpenDota. Use +rs detailed for damage/heal/stun columns.',
          });
      } else {
        embed
          .setThumbnail(targetUser.displayAvatarURL())
          .addFields(
          { name: 'K/D/A', value: `${match.kills}/${match.deaths}/${match.assists}`, inline: true },
          { name: 'KDA', value: ((match.kills + match.assists) / (match.deaths || 1)).toFixed(2), inline: true },
          { name: 'GPM/XPM', value: `${match.gold_per_min}/${match.xp_per_min}`, inline: true },
          { name: 'Last Hits', value: `${match.last_hits}`, inline: true },
          { name: 'Duration', value: formatDuration(match.duration), inline: true },
          { name: 'Mode', value: GAME_MODES[match.game_mode] || 'Unknown', inline: true },
          { name: 'Match', value: `[${match.match_id}](https://www.opendota.com/matches/${match.match_id})`, inline: true },
          );
      }

      const components = !didWin
        ? [createMatchActionRow(match.match_id, { showCoach: true, coachSteamId: user.steamId })]
        : [createMatchActionRow(match.match_id)];
      return message.reply({ embeds: [embed], files, components });
    }

    // Multiple matches — compact summary table
    const heroCache: Record<number, string> = {};
    const getHero = async (id: number) => {
      if (!heroCache[id]) heroCache[id] = await dotaDataService.getHeroName(id);
      return heroCache[id];
    };

    const tableRows: MatchRow[] = await Promise.all(
      matches.map(async (match: any) => {
        const heroName = await getHero(match.hero_id);
        const isRadiant = match.player_slot < 128;
        const didWin = (isRadiant && match.radiant_win) || (!isRadiant && !match.radiant_win);
        return {
          won: didWin,
          hero: heroName,
          heroImageUrl: APIConstants.IMAGE_URL(heroName),
          rankLabel: formatRankLabel(Number(match.average_rank || 0)) ?? undefined,
          kills: match.kills,
          deaths: match.deaths,
          assists: match.assists,
          gpm: match.gold_per_min,
          durationSec: match.duration,
          mode: GAME_MODES[match.game_mode] || 'Unknown',
        };
      })
    );

    const totalGames = matches.length;
    const wins = tableRows.filter((r) => r.won).length;

    const filterDesc = [
      filter.descriptionParts.length ? filter.descriptionParts.join(' • ') : '',
    ].filter(Boolean).join(' | ');

    const tableImage = await renderRecentMatchesTableWithIcons(tableRows, {
      username: targetUser.username,
      wins,
      total: totalGames,
      subtitle: filterDesc || undefined,
    });
    const attachment = new AttachmentBuilder(tableImage, { name: 'recent.png' });

    const embed = new EmbedBuilder()
      .setColor('#7c3aed')
      .setTitle(`📊 Last ${totalGames} Matches — ${targetUser.username}`)
      .setImage('attachment://recent.png')
      .setFooter({ text: `Try +rs 10 won as invoker this week • old flags still work` })
      .setTimestamp();

    await message.reply({ embeds: [embed], files: [attachment] });
  } catch (error) {
    logger.error(`Error in recentStats for user ${discordId}:`, error);
    await message.reply('An error occurred while fetching match history. Please try again later.');
  }
}
