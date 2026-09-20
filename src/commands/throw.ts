import { EmbedBuilder, Message, escapeMarkdown } from 'discord.js';
import { opendotaClient } from '../services/apiClient';
import { UserDataService } from '../services/userDataService';
import { leadGames, leadRate, LeadGame, ThrowMatch, withoutSharedGames } from '../services/throwStats';
import { normalizeSteamId } from '../utils/validators';
import { logger } from '../services/loggerService';

const USAGE = 'Usage: `+throw [@player or Steam ID or OpenDota link] [second player] [turbo|normal] [days=90] [solo|party]`';
const PAGE_SIZE = 500;
const MAX_PER_MODE = 2000;
interface Target { id: string; name: string }

export function parseThrowArgs(args: string[]) {
  let days = 90;
  let mode: 'turbo' | 'normal' = 'turbo';
  let queue: 'all' | 'solo' | 'party' = 'all';
  const targets: string[] = [];
  let seenMode = false;
  let seenQueue = false;
  let seenDays = false;
  for (const raw of args) {
    const arg = raw.toLowerCase();
    if (arg === 'normal' || arg === 'turbo') {
      if (seenMode) throw new Error('Choose one mode.');
      mode = arg; seenMode = true;
    } else if (arg === 'solo' || arg === 'party') {
      if (seenQueue) throw new Error('Choose one queue filter.');
      queue = arg; seenQueue = true;
    } else if (arg.startsWith('days=')) {
      if (seenDays || !/^days=\d+$/.test(arg)) throw new Error('Use days=7 through days=365.');
      days = Number(arg.slice(5)); seenDays = true;
      if (days < 7 || days > 365) throw new Error('Use days=7 through days=365.');
    } else targets.push(raw);
  }
  if (targets.length > 2) throw new Error('Choose at most two players.');
  return { days, mode, queue, targets };
}

async function fetchGames(id: string, days: number, mode: 'turbo' | 'normal', cutoff: number) {
  const matches: ThrowMatch[] = [];
  let capped = false;
  for (const gameMode of mode === 'turbo' ? [23] : [1, 22]) {
    for (let offset = 0; offset < MAX_PER_MODE; offset += PAGE_SIZE) {
      const params = new URLSearchParams({ significant: '0', date: String(days), game_mode: String(gameMode), limit: String(PAGE_SIZE), offset: String(offset) });
      for (const field of ['throw', 'stomp', 'party_size']) params.append('project', field);
      const response = await opendotaClient.get<ThrowMatch[]>(`/players/${id}/matches?${params}`, {
        timeout: 20000, signal: AbortSignal.timeout(25000), 'axios-retry': { retries: 0 },
      } as any);
      if (!Array.isArray(response.data)) throw new Error('Invalid OpenDota match response');
      const rows = response.data;
      matches.push(...rows.filter(row => row.game_mode === gameMode && row.start_time >= cutoff));
      if (rows.length < PAGE_SIZE) break;
      if (offset + PAGE_SIZE === MAX_PER_MODE) capped = true;
    }
  }
  return { matches: [...new Map(matches.map(match => [match.match_id, match])).values()], capped };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
function rateText(games: LeadGame[], threshold: number) {
  const stat = leadRate(games, threshold);
  return stat.rate == null ? 'no qualifying games'
    : `lost **${stat.lost} of ${stat.n}** (${pct(stat.rate)})`;
}

export function comparisonText(aName: string, a: LeadGame[], bName: string, b: LeadGame[]) {
  const ar = leadRate(a, 10000), br = leadRate(b, 10000);
  if (ar.n < 20 || br.n < 20) return '**Too early to hand out the throw crown.**\nThere aren\'t enough separate games with a 10k lead for both players yet.';
  const gap = ar.rate! - br.rate!;
  if (Math.abs(gap) < 0.0005) return '**A tie. Neither gets the throw crown.**\nBoth teams lose 10k-gold leads at the same rate in this sample.';
  const higher = gap > 0 ? aName : bName;
  const overlap = ar.low! <= br.high! && br.low! <= ar.high!;
  return `**${higher} ${overlap ? 'edges it, but it\'s a close call' : 'has the higher throw rate in these games'}.**\n`
    + `After going 10k gold ahead, **${aName}**'s teams still lost **${pct(ar.rate!)}** of those games, versus **${pct(br.rate!)}** for **${bName}**.\n`
    + (overlap ? 'Enough for some banter, not enough for a confident verdict.' : 'That is a team record, not proof of who made the losing play.');
}

export async function throwReport(message: Message, args: string[], users: UserDataService) {
  let opts: ReturnType<typeof parseThrowArgs>;
  const targets: Target[] = [];
  try {
    opts = parseThrowArgs(args);
    for (const token of opts.targets.length ? opts.targets : [`<@${message.author.id}>`]) {
      const mention = token.match(/^<@!?(\d+)>$/);
      if (mention) {
        const user = users.getUserByDiscordId(mention[1]);
        if (!user) throw new Error('That Discord user is not registered. Supply their Steam ID or OpenDota link.');
        targets.push({ id: user.steamId, name: message.mentions.users.get(mention[1])?.username ?? (mention[1] === message.author.id ? message.author.username : `Steam ${user.steamId}`) });
      } else {
        const id = normalizeSteamId(token.replace(/^<|>$/g, ''));
        if (!id || !Number.isSafeInteger(Number(id)) || Number(id) <= 0 || Number(id) > 4294967295) throw new Error('Could not read a player ID or link.');
        targets.push({ id, name: `Steam ${id}` });
      }
    }
    if (targets.length === 2 && targets[0].id === targets[1].id) throw new Error('Choose two different players.');
  } catch (error) {
    return message.reply(`${(error as Error).message}\n${USAGE}`);
  }

  const progress = await message.reply('Checking team gold leads on OpenDota...');
  try {
    const cutoff = Math.floor(Date.now() / 1000) - opts.days * 86400;
    const reports = await Promise.all(targets.map(async target => {
      const [data, profile] = await Promise.all([
        fetchGames(target.id, opts.days, opts.mode, cutoff),
        opendotaClient.get<any>(`/players/${target.id}`, { timeout: 10000, signal: AbortSignal.timeout(15000), 'axios-retry': { retries: 0 } } as any).catch(() => null),
      ]);
      const name = escapeMarkdown(String(profile?.data?.profile?.personaname || target.name).slice(0, 70));
      const usable = leadGames(data.matches);
      const games = usable.filter(game => opts.queue === 'all' || game.party === opts.queue);
      return { ...data, name, usable, games };
    }));
    const scope = `${opts.mode === 'turbo' ? 'Turbo' : 'Normal All Pick + Ranked All Pick'} | last ${opts.days} days | ${opts.queue === 'all' ? 'all queues' : opts.queue}`;
    const embed = new EmbedBuilder().setColor('#e05a47').setTitle(reports.length === 2 ? 'Who throws more?' : 'The Throw Report')
      .setDescription(`${scope}\nHow often does your team build a gold lead, then lose anyway?`);
    for (const report of reports) {
      const losses = report.games.filter(game => !game.won && game.lead >= 5000).sort((a, b) => a.lead - b.lead);
      const mid = Math.floor(losses.length / 2);
      const median = losses.length ? (losses[mid].lead + losses[Math.floor((losses.length - 1) / 2)].lead) / 2 : null;
      const biggest = losses[losses.length - 1];
      embed.addFields({ name: report.name, value: [
        ...[5000, 10000, 15000].map(threshold => `From **${threshold / 1000}k gold ahead**: ${rateText(report.games, threshold)}`),
        median == null ? 'No observed losses from a 5k+ lead.' : `Median lost lead (5k+ defeats): **${Math.round(median).toLocaleString()} gold**`,
        biggest ? `Biggest: **${biggest.lead.toLocaleString()} gold** - [match ${biggest.id}](https://www.opendota.com/matches/${biggest.id})` : '',
        `_${report.games.length} games used. Gold history available for ${report.usable.length}/${report.matches.length} games checked._`,
        `_Selected games: ${report.games.filter(game => game.party === 'solo').length} solo, ${report.games.filter(game => game.party === 'party').length} party, ${report.games.filter(game => game.party === 'unknown').length} unknown._`,
        report.capped ? `History capped at ${MAX_PER_MODE} recent games per mode; window may be incomplete.` : '',
        report.usable.length === 0 ? 'No usable gold data; this is not evidence of zero throws.' : '',
      ].filter(Boolean).join('\n') });
    }
    if (reports.length === 2) {
      const [a, b] = reports;
      const bIds = new Set(b.matches.map(game => game.match_id));
      const shared = new Set(a.matches.filter(game => bIds.has(game.match_id)).map(game => game.match_id));
      const separate = withoutSharedGames(a.games, b.games, shared);
      embed.setDescription(`${comparisonText(a.name, separate.a, b.name, separate.b)}\n\n_${scope}_`);
      embed.addFields({ name: 'Behind the verdict', value:
        `${a.name}: ${rateText(separate.a, 10000)} games from 10k ahead.\n${b.name}: ${rateText(separate.b, 10000)}.\n`
        + (shared.size ? `The verdict leaves out the ${shared.size} games you both played. The player reports above include them.` : 'You had no shared games in this window.') });
    }
    embed.setFooter({ text: 'OpenDota | Team throws, not personal blame. Different teammates and opponents matter. Missing gold history is skipped.' }).setTimestamp();
    await progress.edit({ content: null, embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    logger.warn('Throw report failed:', error);
    await progress.edit('OpenDota could not supply the full report. Please try again later; missing data has not been counted as zero.');
  }
}
