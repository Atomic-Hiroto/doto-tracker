import { EmbedBuilder, Message } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { turboRankService } from '../services/turboRankService';
import { dotaDataService } from '../services/dotaDataService';
import { fetchPlayerTopTurboHero, fetchPlayerHeroItemTimings, fetchHeroItemBenchmarks } from '../services/stratzClient';
import { logger } from '../services/loggerService';

// Per-hero key-item timings from a player's Turbo games, benchmarked against the playerbase.
//   YOU    = the player's average completion time in Turbo
//   PAR    = what an average player hits it at in Turbo = ranked average ÷ 1.8
//   RANKED = Stratz's real ranked/normal-game average (Stratz has no Turbo item data)
//
// Turbo doesn't quite halve item timings: gold is ~2× but XP is also boosted and the
// lane phase is compressed, so real Turbo completion lands ~55-65% of the ranked time.
// 1.8 is the empirical middle of that band (÷2 was too aggressive, making everyone look slow).

const TURBO_PACE_FACTOR = 1.8;
const MATCH_SAMPLE = 20;

// Pure build-up pieces that are never the "key item" anyone wants a timing for.
// (Most components are removed by the component-collapse below; this catches stragglers
//  whose final item wasn't built often enough to trigger the collapse.)
const EXCLUDE_COMPONENTS = new Set(['perseverance', 'sange', 'yasha', 'kaya', 'skull_basher']);

// Not real build choices: Roshan drops & consumed-buff representations (Aghanim's
// Blessing, the consumed-scepter item). These leak into purchase logs but aren't bought.
const NON_BUILD_ITEMS = new Set(['ultimate_scepter_2', 'aghanims_blessing', 'aghanims_blessing_2']);
function isNonBuild(internal: string): boolean {
  return NON_BUILD_ITEMS.has(internal) || internal.includes('blessing');
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}
function fmtMin(min: number): string {
  const m = Math.floor(min);
  return `${m}:${String(Math.round((min - m) * 60)).padStart(2, '0')}`;
}
function verdict(youMin: number, parMin: number | null): string {
  if (parMin == null) return ' ';
  const d = youMin - parMin; // negative = faster than an average turbo player
  if (d <= -3) return '🔥';
  if (d <= -1) return '🟢';
  if (d < 1) return '🟡';
  return '🔴';
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

    await dotaDataService.getItemName(1); // ensure constants loaded for sync lookups

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

    const [matches, benchmarks] = await Promise.all([
      fetchPlayerHeroItemTimings(Number(target.steamId), heroId, MATCH_SAMPLE),
      fetchHeroItemBenchmarks(heroId),
    ]);
    if (matches.length === 0) {
      return loading.edit(`No parsed Turbo **${heroName}** games found for **${target.name}**.`);
    }

    // aggregate per key item (by itemId so we can join the benchmark)
    const perItem = new Map<number, { name: string; count: number; sumSec: number }>();
    let durSum = 0;
    for (const match of matches) {
      durSum += match.durationSeconds;
      const firstById = new Map<number, number>();
      for (const p of match.purchases) {
        const meta = dotaDataService.getItemMeta(p.itemId);
        if (!meta || !meta.isKey) continue;
        const sec = Math.max(0, p.time);
        const cur = firstById.get(p.itemId);
        if (cur == null || sec < cur) firstById.set(p.itemId, sec);
      }
      for (const [itemId, sec] of firstById) {
        const meta = dotaDataService.getItemMeta(itemId)!;
        const e = perItem.get(itemId) ?? { name: meta.name, count: 0, sumSec: 0 };
        e.count++; e.sumSec += sec;
        perItem.set(itemId, e);
      }
    }

    // Collapse to final items: drop any built item that is a component of another built item
    // (e.g. Skull Basher -> Abyssal, Yasha/Kaya -> Yasha & Kaya), plus known build-up pieces.
    const consumed = new Set<string>();
    for (const itemId of perItem.keys()) {
      for (const c of dotaDataService.getItemComponentNames(itemId)) consumed.add(c);
    }
    for (const itemId of [...perItem.keys()]) {
      const internal = dotaDataService.getItemInternalName(itemId);
      if (internal && (consumed.has(internal) || EXCLUDE_COMPONENTS.has(internal) || isNonBuild(internal))) {
        perItem.delete(itemId);
      }
    }

    const games = matches.length;
    const minGames = Math.max(2, Math.ceil(games * 0.25));
    let entries = [...perItem.entries()].filter(([, e]) => e.count >= minGames);
    if (entries.length === 0) entries = [...perItem.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);

    const allRows = entries
      .map(([itemId, e]) => {
        const youMin = e.sumSec / e.count / 60;
        const rankedMin = benchmarks.get(itemId) ?? null;
        const parMin = rankedMin != null ? rankedMin / TURBO_PACE_FACTOR : null;
        return { name: e.name, count: e.count, youMin, parMin, rankedMin };
      })
      .sort((a, b) => a.youMin - b.youMin);

    // Benchmarked items go in the comparison table; the rest become an "also built" line.
    const rated = allRows.filter(r => r.parMin != null).slice(0, 12);
    const unrated = allRows.filter(r => r.parMin == null);
    const faster = rated.filter(r => r.youMin < r.parMin! - 0.5).length;

    const W = 14;
    const header = `${'ITEM'.padEnd(W)}${'YOU'.padStart(6)}${'PAR'.padStart(6)}${'RANKED'.padStart(7)}`;
    const lines = rated.map(r =>
      `${r.name.slice(0, W).padEnd(W)}${fmtMin(r.youMin).padStart(6)}`
      + `${fmtMin(r.parMin!).padStart(6)}${fmtMin(r.rankedMin!).padStart(7)} ${verdict(r.youMin, r.parMin)}`,
    );
    const table = lines.length
      ? '```\n' + header + '\n' + lines.join('\n') + '\n```'
      : '_No items with a Stratz benchmark for this hero yet._';

    const alsoBuilt = unrated.length
      ? unrated.slice(0, 8).map(r => `${r.name} ${fmtMin(r.youMin)}`).join(' · ')
      : '';

    const hype = rated.length
      ? `\n⚡ You beat an average Turbo player's pace on **${faster}/${rated.length}** key items.`
      : '';

    const embed = new EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle(`🛠️ Turbo Item Timings — ${heroName}`)
      .setDescription(
        `**${target.name}** · ${games} Turbo games · avg game ${fmtSec(durSum / games)}\n`
        + '`YOU` your turbo timing · `PAR` average player in turbo · `RANKED` ranked-game average.'
        + hype,
      )
      .addFields({ name: 'When you complete each item', value: table, inline: false });
    if (alsoBuilt) {
      embed.addFields({ name: '🔸 Also built (no benchmark)', value: alsoBuilt, inline: false });
    }
    embed
      .setFooter({ text: 'PAR = RANKED ÷1.8 (turbo\'s faster gold + XP) — Stratz has no turbo item data, so RANKED is the real benchmark · 🔥faster 🟢good 🟡par 🔴slower · ≥25% of games' })
      .setTimestamp();

    await loading.edit({ content: '', embeds: [embed] });
  } catch (error) {
    logger.error('Error in turboitems:', error);
    await message.reply('Failed to build Turbo item-timings report.');
  }
}
