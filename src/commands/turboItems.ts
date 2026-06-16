import { EmbedBuilder, Message } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { turboRankService } from '../services/turboRankService';
import { dotaDataService } from '../services/dotaDataService';
import { fetchPlayerTopTurboHero, fetchPlayerHeroItemTimings } from '../services/stratzClient';
import { logger } from '../services/loggerService';

// Per-hero key-item timings from a player's Turbo games, with a "normal-equivalent"
// column. Turbo doubles all gold & XP (Dota 2 Wiki turbo factor = 2), so you reach an
// item's cost in HALF the time — the normal-game-equivalent timing is turbo timing × 2.

const TURBO_GOLD_FACTOR = 2;
const MATCH_SAMPLE = 20;

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function splitArgs(args: string[]): { playerToken: string | null; heroQuery: string } {
  let playerToken: string | null = null;
  const heroTokens: string[] = [];
  for (const a of args) {
    if ((/^<@!?\d+>$/.test(a) || /^\d{4,}$/.test(a)) && !playerToken) playerToken = a;
    else heroTokens.push(a);
  }
  return { playerToken, heroQuery: heroTokens.join(' ').trim() };
}

async function resolvePlayer(
  message: Message,
  token: string | null,
  userDataService: UserDataService,
): Promise<{ steamId: string; name: string } | { error: string }> {
  if (!token) {
    const self = userDataService.getUserByDiscordId(message.author.id);
    if (!self) return { error: "You're not registered. Use `+register <steamId>`, or pass a @mention / steamId." };
    return { steamId: self.steamId, name: turboRankService.getSteamName(self.steamId) ?? message.author.username };
  }
  const m = token.match(/^<@!?(\d+)>$/);
  if (m) {
    const user = userDataService.getUserByDiscordId(m[1]);
    if (!user) return { error: 'That user is not registered. They need `+register <steamId>` first.' };
    return { steamId: user.steamId, name: turboRankService.getSteamName(user.steamId) ?? `Steam ${user.steamId}` };
  }
  return { steamId: token, name: turboRankService.getSteamName(token) ?? `Steam ${token}` };
}

export async function turboItems(message: Message, args: string[], userDataService: UserDataService) {
  try {
    const { playerToken, heroQuery } = splitArgs(args);
    const target = await resolvePlayer(message, playerToken, userDataService);
    if ('error' in target) return message.reply(target.error);

    // ensure hero/item constants are loaded before using the sync lookups
    await dotaDataService.getItemName(1);

    let heroId: number | null = null;
    let heroName = '';
    if (heroQuery) {
      const hero = dotaDataService.findHeroByName(heroQuery);
      if (!hero) return message.reply(`Couldn't find a hero matching "${heroQuery}". Try the full name, e.g. \`+turboitems phantom assassin\`.`);
      heroId = hero.id;
      heroName = hero.localized_name;
    }

    const loading = await message.reply(
      `⏳ Pulling Turbo item timings for **${target.name}**${heroName ? ` on **${heroName}**` : ''}…`,
    );

    if (heroId == null) {
      heroId = await fetchPlayerTopTurboHero(Number(target.steamId));
      if (heroId == null) return loading.edit(`Couldn't find recent Turbo games for **${target.name}**.`);
      heroName = await dotaDataService.getHeroName(heroId);
    }

    const matches = await fetchPlayerHeroItemTimings(Number(target.steamId), heroId, MATCH_SAMPLE);
    if (matches.length === 0) {
      return loading.edit(`No parsed Turbo **${heroName}** games found for **${target.name}** (Stratz may not have item data for their recent games).`);
    }

    // aggregate: per key item -> games-built count + avg first-completion time
    const perItem = new Map<string, { count: number; sumSec: number; cost: number }>();
    let durSum = 0;
    for (const match of matches) {
      durSum += match.durationSeconds;
      const firstByName = new Map<string, { sec: number; cost: number }>();
      for (const p of match.purchases) {
        const meta = dotaDataService.getItemMeta(p.itemId);
        if (!meta || !meta.isKey) continue;
        const sec = Math.max(0, p.time); // clamp pre-horn (negative) buys to 0
        const cur = firstByName.get(meta.name);
        if (!cur || sec < cur.sec) firstByName.set(meta.name, { sec, cost: meta.cost });
      }
      for (const [name, v] of firstByName) {
        const e = perItem.get(name) ?? { count: 0, sumSec: 0, cost: v.cost };
        e.count++; e.sumSec += v.sec; e.cost = v.cost;
        perItem.set(name, e);
      }
    }

    const games = matches.length;
    const minGames = Math.max(2, Math.ceil(games * 0.25)); // built in ≥25% of games
    let rows = [...perItem.entries()]
      .filter(([, e]) => e.count >= minGames)
      .map(([name, e]) => ({ name, count: e.count, avgSec: e.sumSec / e.count }))
      .sort((a, b) => a.avgSec - b.avgSec); // chronological build order
    if (rows.length === 0) {
      // fall back to the most common items if nothing cleared the threshold
      rows = [...perItem.entries()]
        .map(([name, e]) => ({ name, count: e.count, avgSec: e.sumSec / e.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .sort((a, b) => a.avgSec - b.avgSec);
    }
    rows = rows.slice(0, 10);

    const W = 16;
    const header = `${'ITEM'.padEnd(W)} ${'BUILT'.padStart(5)} ${'TURBO'.padStart(5)} ${'NORM×2'.padStart(6)}`;
    const lines = rows.map(r =>
      `${r.name.slice(0, W).padEnd(W)} ${`${r.count}/${games}`.padStart(5)} ${fmtTime(r.avgSec).padStart(5)} ${fmtTime(r.avgSec * TURBO_GOLD_FACTOR).padStart(6)}`,
    );
    const avgDur = fmtTime(durSum / games);

    const embed = new EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle(`🛠️ Turbo Item Timings — ${heroName}`)
      .setDescription(
        `**${target.name}** · ${games} recent Turbo games · avg game ${avgDur}\n`
        + `Timings = when each key item **completes**. Turbo doubles gold & XP, so **NORM×2** = the comparable normal-game timing.`,
      )
      .addFields({ name: 'Key item build', value: '```\n' + header + '\n' + lines.join('\n') + '\n```', inline: false })
      .setFooter({ text: 'Turbo factor ×2 (Dota 2 Wiki) · NORM×2 = turbo timing × 2 · items built in ≥25% of games' })
      .setTimestamp();

    await loading.edit({ content: '', embeds: [embed] });
  } catch (error) {
    logger.error('Error in turboitems:', error);
    await message.reply('Failed to build Turbo item-timings report.');
  }
}
