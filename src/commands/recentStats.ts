import { Message, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { APIConstants, Replies } from '../constants';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { parseArgs, parseIntArg } from '../utils/argParser';
import { formatDuration } from '../utils/formatters';
import { safeTyping, safeReply } from '../utils/channelHelpers';
import { createMatchActionRow } from '../components/matchButtons';
import { renderRecentMatchesTableWithIcons, renderScoreboardFromMatch, MatchRow } from '../services/chartService';
import { applyResidualFilters, parseMatchFilter, queryString } from '../utils/matchFilter';
import { formatRankLabel } from '../services/rankDisplayService';
import { fetchCombinedMatch, sourceCredit, sourceNotice } from '../services/matchSourceService';
import { fetchStratzPlayerRecentMatches } from '../services/stratzClient';

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
    return safeReply(message, Replies.notRegistered(message.author.id, discordId, targetUser.username));
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
    // Both providers can serve this, and neither is reliably up. OpenDota stays
    // first because it is the only one that understands the filter DSL, but a
    // plain "last N matches" falls through to STRATZ rather than failing.
    let matches: any[] = [];
    let listNotice: string | null = null;
    try {
      // The unfiltered path has STRATZ behind it, so it doesn't sit through
      // OpenDota's retry ladder; the filtered path has no fallback and keeps it.
      const response = await opendotaClient.get<Array<any>>(
        endpoint,
        filter.consumedAny ? undefined : ({ timeout: 12000, 'axios-retry': { retries: 0 } } as any),
      );
      matches = applyResidualFilters(response.data || [], filter);
    } catch (listError) {
      logger.warn(`+rs: OpenDota match list failed for ${user.steamId}, falling back to STRATZ:`, listError);
      if (filter.consumedAny) {
        return safeReply(
          message,
          "OpenDota isn't responding right now, and the filters (`won`, `as invoker`, `this week`…) only work there. "
          + 'A plain `+rs` or `+rs 5` still works — those can come from STRATZ.',
        );
      }
      matches = await fetchStratzPlayerRecentMatches(Number(user.steamId), fetchCount);
      if (matches.length === 0) throw listError;
      listNotice = "⚠️ OpenDota didn't respond — this came from STRATZ instead.";
    }

    if (matches.length === 0) {
      return safeReply(message, filter.consumedAny ? 'No matches found with those filters.' : 'No recent matches found for this user.');
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
      let boardNotice: string | null = null;
      let boardCredit: string | null = null;

      try {
        // Asks OpenDota and STRATZ at the same time and renders from whichever
        // answered, merging the medals both are willing to show.
        const combined = await fetchCombinedMatch(Number(match.match_id));
        if (combined) {
          const board = await renderScoreboardFromMatch(
            combined.match,
            [user.steamId],
            combined.rankDisplay,
            { detailed: detailedView },
          );
          files.push(new AttachmentBuilder(board, { name: 'scoreboard.png' }));
          hasBoard = true;
          boardNotice = sourceNotice(combined);
          boardCredit = sourceCredit(combined);
        } else {
          boardNotice = "⚠️ Neither OpenDota nor STRATZ has this match yet — showing the summary only.";
        }
      } catch (boardError) {
        logger.warn(`Could not render +rs scoreboard for match ${match.match_id}:`, boardError);
      }

      const embed = new EmbedBuilder()
        .setColor(didWin ? '#66bb6a' : '#ef5350')
        .setTitle(`Recent Match — ${targetUser.username}`)
        .setDescription(
          [`**${didWin ? '✅ Victory' : '❌ Defeat'}** as **${heroName}**`, listNotice, boardNotice]
            .filter(Boolean)
            .join('\n'),
        )
        .setURL(`https://www.opendota.com/matches/${match.match_id}`)
        .setTimestamp(new Date(match.start_time * 1000));

      if (hasBoard) {
        embed
          .setImage('attachment://scoreboard.png')
          .setFooter({
            text: [
              boardCredit ?? 'Ranks shown when visible',
              detailedView
                ? 'G/X, net/LH/DN, hero+tower damage, healing, stun'
                : '+rs detailed adds damage/heal/stun columns',
            ].join(' • '),
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
      return safeReply(message, { embeds: [embed], files, components });
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
      listNotice ? 'source: STRATZ (OpenDota unavailable)' : '',
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
      .setDescription(listNotice ?? null)
      .setFooter({ text: `Try +rs 10 won as invoker this week • old flags still work` })
      .setTimestamp();

    await safeReply(message, { embeds: [embed], files: [attachment] });
  } catch (error) {
    logger.error(`Error in recentStats for user ${discordId}:`, error);
    await safeReply(message, 'An error occurred while fetching match history. Please try again later.');
  }
}
