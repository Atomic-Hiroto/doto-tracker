import { EmbedBuilder, Message } from 'discord.js';
import { ProcessConstants } from '../constants';
import { fetchPlayerTurboMatches } from '../services/stratzClient';
import { logger } from '../services/loggerService';
import { TurboStatsService } from '../services/turboStatsService';
import { UserDataService } from '../services/userDataService';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function turboBackfill(message: Message, args: string[], users: UserDataService, stats: TurboStatsService) {
  if (message.author.id !== ProcessConstants.BOT_OWNER_ID) {
    return message.reply('❌ Only the bot owner can run the historical Turbo sync.');
  }

  const days = Math.max(7, Math.min(1825, Number.parseInt(args[0] || '365', 10) || 365));
  const maxPerPlayer = Math.max(50, Math.min(1000, Number.parseInt(args[1] || '200', 10) || 200));
  const allUsers = users.getAllUsers();
  const roster = allUsers.map(user => ({ discordId: user.discordId, steamId: user.steamId }));
  const historyAnchors = allUsers.filter(user => user.historyAccessible !== false);
  if (!roster.length) return message.reply('There are no registered players to sync.');

  const progress = await message.reply(`🧾 Syncing up to **${maxPerPlayer}** Turbo matches per player from the last **${days} days** for **${roster.length}** registered players…`);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  let fetchedRows = 0;
  let changedMatches = 0;
  const seenResponses = new Set<string>();

  try {
    for (let i = 0; i < historyAnchors.length; i++) {
      const player = historyAnchors[i];
      for (let skip = 0; skip < maxPerPlayer; skip += 100) {
        const take = Math.min(100, maxPerPlayer - skip);
        const matches = await fetchPlayerTurboMatches(Number(player.steamId), take, skip, since, null);
        fetchedRows += matches.length;
        for (const match of matches) {
          const responseKey = `${player.steamId}:${match.id}`;
          if (seenResponses.has(responseKey)) continue;
          seenResponses.add(responseKey);
          if (stats.processTurboMatch(match, roster, 'historical', true)) changedMatches++;
        }
        if (matches.length < take) break;
        await delay(500);
      }
      if (i === historyAnchors.length - 1 || i % 2 === 1) {
        await progress.edit(`🧾 Historical Turbo sync: **${i + 1}/${historyAnchors.length}** public-history players · ${fetchedRows} rows fetched · ${changedMatches} new/expanded matches`).catch(() => {});
      }
      if (i < historyAnchors.length - 1) await delay(700);
    }

    stats.markBackfillComplete();
    const ledger = stats.getAllStats().matches || [];
    const embed = new EmbedBuilder()
      .setColor('#10b981')
      .setTitle('✅ Turbo History Sync Complete')
      .setDescription(`The deduplicated ledger now contains **${ledger.length}** matches across **${roster.length}** registered players.`)
      .addFields(
        { name: 'This run', value: `${fetchedRows} API rows fetched\n${changedMatches} matches added or expanded`, inline: true },
        { name: 'Try it', value: '`+turbopairs all`\n`+turbopairs history`\n`+turboparty best all`', inline: true }
      )
      .setFooter({ text: 'Safe to rerun: match IDs and registered participants are merged, not double-counted.' })
      .setTimestamp();
    return progress.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Turbo history backfill failed:', error);
    return progress.edit('❌ Historical Turbo sync failed. No aggregate rebuild was completed; check the logs and rerun it.');
  }
}
