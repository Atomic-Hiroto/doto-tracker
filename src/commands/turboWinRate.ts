import { EmbedBuilder, Message } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { turboRankService } from '../services/turboRankService';
import { fetchPlayerTurboMatches } from '../services/stratzClient';
import { logger } from '../services/loggerService';

// Win rate by lobby bracket (medal of the lobby) and by party size (solo / duo / 3-stack+).
// Purely descriptive — counts wins/losses from match history, no estimation involved.

const MEDAL_NAMES = ['', 'Herald', 'Guardian', 'Crusader', 'Archon', 'Legend', 'Ancient', 'Divine', 'Immortal'];
const ONE_YEAR_AGO = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;

type Bucket = { wins: number; games: number };
function emptyBucket(): Bucket { return { wins: 0, games: 0 }; }
function pct(b: Bucket): string {
  return b.games > 0 ? `${Math.round((b.wins / b.games) * 100)}%` : '—';
}
/** 10-cell win-rate bar, e.g. 60% -> ██████░░░░ */
function bar(b: Bucket): string {
  if (b.games === 0) return '·'.repeat(10);
  const filled = Math.max(0, Math.min(10, Math.round((b.wins / b.games) * 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}
/** Aligned monospace row: "Divine      48g  █████░░░░░  46%" */
function row(label: string, b: Bucket): string {
  if (b.games === 0) return `${label.padEnd(11)}${'0g'.padStart(5)}`;
  return `${label.padEnd(11)}${(b.games + 'g').padStart(5)}  ${bar(b)} ${(pct(b)).padStart(4)}`;
}

type BracketSlot = { all: Bucket; solo: Bucket; party: Bucket };
type SizeSplit = { solo: Bucket; duo: Bucket; squad: Bucket; partyNA: Bucket };

function buildSummary(
  overall: Bucket,
  order: [number, BracketSlot][],
  bySize: SizeSplit,
): string {
  const p = overall.games ? overall.wins / overall.games : 0.5;
  const verdict = p >= 0.55 ? 'winning more than they lose'
    : p <= 0.45 ? 'losing more than they win'
    : 'holding their own (~50/50)';

  const sizes: [string, Bucket][] = [
    ['solo queue', bySize.solo], ['duos', bySize.duo],
    ['3-stacks', bySize.squad], ['groups', bySize.partyNA],
  ];
  const dom = [...sizes].sort((a, b) => b[1].games - a[1].games)[0];

  const strong = order
    .filter(([, b]) => b.all.games >= 10)
    .sort((a, b) => (b[1].all.wins / b[1].all.games) - (a[1].all.wins / a[1].all.games))[0];
  const strongTxt = strong ? ` Best in **${MEDAL_NAMES[strong[0]]}** lobbies (${pct(strong[1].all)}).` : '';

  return `**${overall.games}** Turbo games in the last year · overall **${pct(overall)}** — ${verdict}.\n`
    + `Mostly plays in **${dom[0]}**.${strongTxt}`;
}

/** Average lobby medal tier (1-8) for a match: prefer averageRank, fall back to opponent seasonRanks. */
function lobbyMedalTier(match: any, steamId: string): number | null {
  const ar = match.averageRank;
  if (typeof ar === 'number' && ar > 0) return Math.min(8, Math.max(1, Math.floor(ar / 10)));
  const others = (match.players ?? []).filter((p: any) => String(p.steamAccountId) !== String(steamId));
  const tiers = others.map((p: any) => p.steamAccount?.seasonRank).filter((r: any) => typeof r === 'number' && r > 0);
  if (tiers.length < 3) return null;
  const avg = tiers.reduce((s: number, v: number) => s + v, 0) / tiers.length;
  return Math.min(8, Math.max(1, Math.floor(avg / 10)));
}

/** Reliable party size from a positive partyId; null when unknowable. */
function knownPartySize(match: any, steamId: string): number | null {
  const me = (match.players ?? []).find((p: any) => String(p.steamAccountId) === String(steamId));
  const pid = me?.partyId;
  if (typeof pid !== 'number' || pid <= 0) return null;
  const n = (match.players ?? []).filter((p: any) => p.partyId === pid).length;
  return n >= 2 ? Math.min(5, n) : 2; // a party game that looks lone is still ≥ duo
}

async function fetchAll(steamId: string, isParty: boolean): Promise<any[]> {
  const out: any[] = [];
  for (let skip = 0; skip < 200; skip += 100) {
    const page = await fetchPlayerTurboMatches(Number(steamId), 100, skip, ONE_YEAR_AGO, isParty);
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

async function resolveTarget(
  message: Message,
  args: string[],
  userDataService: UserDataService,
): Promise<{ steamId: string; name: string } | { error: string }> {
  const arg = args[0];
  const mention = arg?.match(/^<@!?(\d+)>$/);
  if (mention) {
    const user = userDataService.getUserByDiscordId(mention[1]);
    if (!user) return { error: 'That user is not registered. They need `+register <steamId>` first.' };
    const name = turboRankService.getSteamName(user.steamId) ?? `Steam ${user.steamId}`;
    return { steamId: user.steamId, name };
  }
  if (arg && /^\d{4,}$/.test(arg)) {
    const name = turboRankService.getSteamName(arg)
      ?? userDataService.getUserBySteamId(arg)?.discordId
      ?? `Steam ${arg}`;
    return { steamId: arg, name };
  }
  if (arg) {
    const player = turboRankService.getPlayerByName(arg);
    if (player) return { steamId: player.steamId, name: turboRankService.getSteamName(player.steamId) ?? arg };
    return { error: `Couldn't find a player named "${arg}". Try a @mention or steamId.` };
  }
  const self = userDataService.getUserByDiscordId(message.author.id);
  if (!self) return { error: "You're not registered. Use `+register <steamId>`, or pass a @mention / steamId." };
  return { steamId: self.steamId, name: turboRankService.getSteamName(self.steamId) ?? message.author.username };
}

export async function turboWinRate(message: Message, args: string[], userDataService: UserDataService) {
  try {
    const target = await resolveTarget(message, args, userDataService);
    if ('error' in target) return message.reply(target.error);

    const loading = await message.reply(`⏳ Crunching Turbo win rates for **${target.name}**…`);

    const [solo, party] = await Promise.all([
      fetchAll(target.steamId, false),
      fetchAll(target.steamId, true),
    ]);

    if (solo.length === 0 && party.length === 0) {
      return loading.edit(`No Turbo matches found for **${target.name}** in the last year.`);
    }

    // bracket (medal tier) → overall / solo / party buckets
    const byBracket = new Map<number, BracketSlot>();
    const bySize: SizeSplit = { solo: emptyBucket(), duo: emptyBucket(), squad: emptyBucket(), partyNA: emptyBucket() };
    const overall = emptyBucket();

    const tally = (match: any, isPartyGame: boolean) => {
      const me = (match.players ?? []).find((p: any) => String(p.steamAccountId) === String(target.steamId));
      if (!me || typeof match.didRadiantWin !== 'boolean') return;
      const won = me.isRadiant === match.didRadiantWin;
      const tier = lobbyMedalTier(match, target.steamId);
      const add = (b: Bucket) => { b.games++; if (won) b.wins++; };

      add(overall);
      if (tier != null) {
        if (!byBracket.has(tier)) byBracket.set(tier, { all: emptyBucket(), solo: emptyBucket(), party: emptyBucket() });
        const slot = byBracket.get(tier)!;
        add(slot.all);
        add(isPartyGame ? slot.party : slot.solo);
      }

      if (!isPartyGame) {
        add(bySize.solo);
      } else {
        const size = knownPartySize(match, target.steamId);
        if (size === 2) add(bySize.duo);
        else if (size != null && size >= 3) add(bySize.squad);
        else add(bySize.partyNA); // party game Stratz won't confirm a size for
      }
    };

    solo.forEach(m => tally(m, false));
    party.forEach(m => tally(m, true));

    const order = [...byBracket.entries()].sort((a, b) => b[0] - a[0]);
    const bracketTable = order.map(([tier, b]) => row(MEDAL_NAMES[tier] ?? `Tier ${tier}`, b.all)).join('\n');

    const sizeTable = [
      row('Solo', bySize.solo),
      bySize.duo.games ? row('Duo', bySize.duo) : null,
      row('3-Stack+', bySize.squad),
      bySize.partyNA.games ? row('Group (?)', bySize.partyNA) : null,
    ].filter(Boolean).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#38bdf8')
      .setTitle(`🎯 Turbo Win Rate — ${target.name}`)
      .setDescription(buildSummary(overall, order, bySize))
      .addFields(
        {
          name: '📊 Win rate by lobby bracket',
          value: '```\n' + (bracketTable || 'Not enough rank-visible lobbies.') + '\n```',
          inline: false,
        },
        {
          name: '👥 Win rate by party size',
          value: '```\n' + sizeTable + '\n```',
          inline: false,
        },
      )
      .setFooter({ text: 'Bars show win rate · last 12 months · "Group (size?)" = party games Stratz won\'t confirm a size for' })
      .setTimestamp();

    await loading.edit({ content: '', embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbowinrate:', error);
    await message.reply('Failed to build Turbo win-rate report.');
  }
}
