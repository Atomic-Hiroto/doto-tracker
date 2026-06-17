import { Message, EmbedBuilder } from 'discord.js';
import { Replies } from '../constants';
import { UserDataService } from '../services/userDataService';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { fetchPlayerTurboPositions } from '../services/stratzClient';
import { safeTyping } from '../utils/channelHelpers';

// "Top turbo heroes" ranked the way an analyst would defend it:
//   backbone = Wilson lower-bound of win rate (conservative; crushes lucky small samples)
//   + edge vs the player's own baseline WR (heroes you genuinely over-perform on)
//   + a small role-aware IMPACT nudge that corroborates the win rate (and flags flukes)
// Window = last 60 days measured FROM THE PLAYER'S LATEST GAME (so inactive stretches
// still show their last active form), configurable with a day count.

const MIN_RANKED_GAMES = 5;
const DEFAULT_WINDOW_DAYS = 60;
const WINDOWED_SHRINK_MIN = 12;
const WINDOWED_SHRINK_MAX = 35;
const LIFETIME_SHRINK_MIN = 18;
const LIFETIME_PROVEN_SHRINK_MIN = 35;
const LIFETIME_SHRINK_MAX = 60;

// turbo percentile thresholds: good ≈ p85, elite ≈ p97 (1000 pooled crew games)
const IMPACT: Record<string, { good: number; elite: number; fmt: (v: number) => string }> = {
  gpm:        { good: 1530, elite: 1830,  fmt: v => `${Math.round(v)} GPM` },
  lastHits:   { good: 196,  elite: 283,   fmt: v => `${Math.round(v)} LH` },
  assists:    { good: 20,   elite: 26,    fmt: v => `${v.toFixed(1)} assists` },
  heroDamage: { good: 41500, elite: 67000, fmt: v => `${(v / 1000).toFixed(1)}k dmg` },
  stuns:      { good: 30,   elite: 60,    fmt: v => `${Math.round(v)}s stuns` },
  healing:    { good: 8000, elite: 15000, fmt: v => `${(v / 1000).toFixed(1)}k healing` },
};
const ROLE_METRICS: Record<string, string[]> = {
  Carry: ['gpm', 'lastHits'],
  Initiator: ['stuns'],
  Disabler: ['stuns'],
  Support: ['assists', 'healing'],
  Nuker: ['heroDamage'],
};
// Role tag follows the player's actual farm priority, not the hero's stereotype:
// averaging >=700 GPM on a hero in turbo means you played it as a core (so a
// mid/offlane Ogre never reads "Support"). Pick the most apt core descriptor.
const CORE_GPM = 700;
const CORE_ROLE_PREF = ['Carry', 'Initiator', 'Nuker', 'Disabler', 'Pusher', 'Durable', 'Escape'];
const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const MAX_TOP = 10;

// Which stats define "impact" for the position the player ACTUALLY played (from Stratz).
// A safelane carry is judged on farm — never on stun duration — so a stun-capable carry
// like Wraith King doesn't get an off-role "elite stuns" bonus that distorts the ranking.
const POSITION_METRICS: Record<string, string[]> = {
  Safelane: ['gpm', 'lastHits'],
  Mid: ['gpm', 'heroDamage'],
  Offlane: ['stuns', 'heroDamage'],
  'Soft Sup': ['stuns', 'assists'],
  'Hard Sup': ['assists', 'healing'],
};

/** Impact metrics to judge a hero by: Stratz position first, else farm-priority (GPM) split. */
function metricsFor(posLabel: string | undefined, gpm: number | undefined): string[] {
  if (posLabel && POSITION_METRICS[posLabel]) return POSITION_METRICS[posLabel];
  return (gpm ?? 0) >= CORE_GPM ? ['gpm', 'lastHits', 'heroDamage'] : ['stuns', 'assists', 'healing'];
}

function bestImpact(metrics: string[], avgs: Record<string, number | undefined>) {
  let best: { metric: string; q: number; ratio: number; text: string } | null = null;
  for (const m of metrics) {
    const v = avgs[m];
    if (v == null || !isFinite(v) || v <= 0) continue;
    const t = IMPACT[m];
    const q = v >= t.elite ? 2 : v >= t.good ? 1 : 0;
    const ratio = v / t.good;
    if (!best || q > best.q || (q === best.q && ratio > best.ratio)) best = { metric: m, q, ratio, text: t.fmt(v) };
  }
  return best;
}

interface HeroAgg { heroId: number; games: number; win: number; rows: any[]; }

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function chooseShrinkK(windowDays: number, totalGames: number, heroGames: number[]): number {
  const regularHeroGames = percentile(heroGames, 0.8);

  if (windowDays === Infinity) {
    // Lifetime views should value proven mains, but newer players should not need
    // 45+ games before any hero can move away from baseline.
    const minK = totalGames >= 2500 ? LIFETIME_PROVEN_SHRINK_MIN : LIFETIME_SHRINK_MIN;
    const poolK = totalGames >= 2500 ? totalGames / 90 : Math.sqrt(totalGames) * 0.9;
    const distributionCap = Math.max(minK, regularHeroGames);
    return clamp(Math.round(Math.min(poolK, distributionCap)), minK, LIFETIME_SHRINK_MAX);
  }

  // Recent windows need to stay responsive. Scale with both activity and window
  // length, then cap it by what a regular high-use hero actually looks like here.
  const boundedDays = clamp(windowDays, 14, 180);
  const poolK = Math.sqrt(totalGames) * Math.sqrt(boundedDays / DEFAULT_WINDOW_DAYS) * 1.15;
  const distributionCap = Math.max(MIN_RANKED_GAMES * 2.5, regularHeroGames * 0.75);
  return clamp(Math.round(Math.min(poolK, distributionCap)), WINDOWED_SHRINK_MIN, WINDOWED_SHRINK_MAX);
}

export async function tophero(message: Message, args: string[], userDataService: UserDataService) {
  let discordId = message.author.id;
  let targetUser = message.author;
  if (message.mentions.users.size > 0) {
    discordId = message.mentions.users.first()!.id;
    targetUser = message.mentions.users.first()!;
  }
  const user = userDataService.getUserByDiscordId(discordId);
  if (!user) return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));

  // Parse args (mentions excluded). `topN` controls how many heroes show (default 5, max 10);
  // a bare number or `all` controls the day window back from the player's latest game.
  const tokens = args.filter(a => !a.startsWith('<@')).map(a => a.toLowerCase());
  const topTok = tokens.find(a => /^top\d+$/.test(a));
  const topN = topTok ? Math.max(1, Math.min(MAX_TOP, Number(topTok.slice(3)))) : 5;
  const winArg = tokens.find(a => a === 'all' || /^\d+$/.test(a));
  const windowDays = winArg === 'all' ? Infinity : (winArg ? Number(winArg) : DEFAULT_WINDOW_DAYS);

  try {
    safeTyping(message.channel);

    // `all` pulls deep history (the 500 cap was silently truncating veteran players'
    // lifetime hero counts); windowed views scale with the days requested to capture
    // history for active players. We cap at 2500 to prevent OpenDota API timeouts on
    // the unauthenticated tier for massive queries.
    const fetchLimit = windowDays === Infinity ? 2500 : Math.min(2500, Math.max(500, windowDays * 6));
    const matches = await opendotaClient.get<any[]>(
      `/players/${user.steamId}/matches?game_mode=23&significant=0&limit=${fetchLimit}`
      + '&project=hero_id&project=start_time&project=assists&project=gold_per_min'
      + '&project=xp_per_min&project=last_hits&project=hero_damage&project=hero_healing',
    ).then(r => r.data || []).catch((e: any) => {
      logger.error(`OpenDota API error for ${user.steamId}:`, e.message);
      if (e.response) {
        logger.error(`Status: ${e.response.status}, Data:`, e.response.data);
      }
      throw new Error('Failed to fetch matches from OpenDota (possibly rate limited).');
    });

    if (matches.length === 0) {
      return message.reply(`No turbo games found for ${targetUser.username}. Play some turbo! ⚡`);
    }

    // Window back from the LATEST game, not from today.
    const latestTs = Math.max(...matches.map(m => Number(m.start_time || 0)));
    const cutoff = windowDays === Infinity ? 0 : latestTs - windowDays * 86400;
    const inWindow = matches.filter(m => Number(m.start_time || 0) >= cutoff);

    // Aggregate per hero from the matches themselves (win = my side won).
    const byHero = new Map<number, HeroAgg>();
    let totalGames = 0, totalWins = 0;
    for (const m of inWindow) {
      const heroId = Number(m.hero_id);
      if (!heroId) continue;
      const won = (m.player_slot < 128) === !!m.radiant_win;
      const agg = byHero.get(heroId) ?? { heroId, games: 0, win: 0, rows: [] };
      agg.games++; if (won) agg.win++; agg.rows.push(m);
      byHero.set(heroId, agg);
      totalGames++; if (won) totalWins++;
    }
    if (totalGames === 0) {
      return message.reply(`No turbo games in that window for ${targetUser.username}. Try \`+topheros all\`.`);
    }
    const baselineWR = totalWins / totalGames;
    const avgOf = (rows: any[], f: string) => rows.length ? rows.reduce((s, r) => s + Number(r[f] || 0), 0) / rows.length : undefined;

    // The career ('all') view has abundant data, so demand a real sample to qualify.
    // For windowed views, scale the minimum up based on the window length (up to 15),
    // but bounded by the player's actual total game volume so low-activity players
    // aren't left with empty rankings.
    let minGames = MIN_RANKED_GAMES;
    if (windowDays === Infinity) {
      minGames = 15;
    } else {
      const timeScale = Math.round(windowDays / 24); // 360d -> 15 games, 180d -> 8 games
      const volumeScale = Math.max(MIN_RANKED_GAMES, Math.floor(totalGames / 20)); // 200g -> 10 games
      minGames = Math.max(MIN_RANKED_GAMES, Math.min(15, timeScale, volumeScale));
    }

    const candidates = [...byHero.values()].filter(h => h.games >= minGames);
    const shrinkK = chooseShrinkK(windowDays, totalGames, candidates.map(h => h.games));

    const ranked = candidates.map(h => {
      const wr = h.win / h.games;
      const edge = wr - baselineWR;
      // Empirical-Bayes shrinkage toward the player's own baseline: shrinkK pseudo-games
      // pull small samples to the mean so they can't spike to #1 on a tiny sample.
      const shrunk = (h.win + shrinkK * baselineWR) / (h.games + shrinkK);
      const preScore = shrunk * 100 + Math.min(h.games, 200) * 0.01;
      return { ...h, wr, edge, preScore };
    }).sort((a, b) => b.preScore - a.preScore);

    const top = ranked.slice(0, Math.min(ranked.length, topN + 2));

    // Stratz-inferred position per hero (one call). Drives both the role tag AND which
    // stats we judge impact by, so a carry is never rated on stun duration.
    const posByHero = await fetchPlayerTurboPositions(Number(user.steamId)).catch(() => new Map<number, string>());
    const impactMetrics = (h: HeroAgg) => metricsFor(posByHero.get(h.heroId), avgOf(h.rows, 'gold_per_min'));

    // Stun seconds (per-match parse) only for heroes whose judged metrics include stuns.
    const stunsByHero = new Map<number, number>();
    await Promise.all(top.map(async h => {
      if (!impactMetrics(h).includes('stuns')) return;
      const vals = await Promise.all(h.rows.slice(0, 3).map(r =>
        opendotaClient.get<any>(`/matches/${r.match_id}`).then(res => {
          const p = (res.data.players || []).find((pl: any) => String(pl.account_id || '') === String(user.steamId));
          return p && typeof p.stuns === 'number' ? p.stuns : null;
        }).catch(() => null),
      ));
      const ok = vals.filter((v): v is number => v != null);
      if (ok.length) stunsByHero.set(h.heroId, ok.reduce((s, v) => s + v, 0) / ok.length);
    }));

    const scored = top.map(h => {
      const avgs = {
        gpm: avgOf(h.rows, 'gold_per_min'),
        lastHits: avgOf(h.rows, 'last_hits'),
        assists: avgOf(h.rows, 'assists'),
        heroDamage: avgOf(h.rows, 'hero_damage'),
        healing: avgOf(h.rows, 'hero_healing'),
        stuns: stunsByHero.get(h.heroId),
      };
      const imp = bestImpact(impactMetrics(h), avgs);
      const impBonus = imp ? (imp.q === 2 ? 2 : imp.q === 1 ? 1 : 0) : 0;
      return { ...h, imp, gpm: avgs.gpm, score: h.preScore + impBonus };
    }).sort((a, b) => b.score - a.score).slice(0, topN);

    const heroLines = await Promise.all(scored.map(async (h, i) => {
      const heroName = await dotaDataService.getHeroName(h.heroId);
      const roles = dotaDataService.getHeroRoles(h.heroId);
      // Prefer Stratz's actual position; else infer core/support from the player's farm (GPM).
      const playedCore = (h.gpm ?? 0) >= CORE_GPM;
      const roleTag = posByHero.get(h.heroId)
        ?? (playedCore
          ? (CORE_ROLE_PREF.find(r => roles.includes(r)) ?? 'Core')
          : (roles.includes('Support') ? 'Support' : (roles[0] ?? 'Flex')));
      const edgePct = `${h.edge >= 0 ? '+' : ''}${Math.round(h.edge * 100)}%`;
      const flags: string[] = [];
      if (h.games < 8) flags.push('⚠ small sample');
      const qLabel = h.imp
        ? (h.imp.q === 2 ? ' (elite)' : h.imp.q === 1 ? ' (strong)' : h.imp.ratio >= 0.85 ? ' (solid)' : '')
        : '';
      return {
        name: `${MEDALS[i] ?? `${i + 1}.`} ${heroName} — ${h.score.toFixed(1)} · ${roleTag}`,
        value: `**${h.games}** games · **${h.win}**W-**${h.games - h.win}**L · **${Math.round(h.wr * 100)}% WR** (${edgePct} vs your ${Math.round(baselineWR * 100)}%)`
          + (h.imp ? `\n💪 ${h.imp.text}${qLabel}` : '')
          + (flags.length ? `\n${flags.join(' · ')}` : ''),
        inline: false,
      };
    }));

    // Heroes below the qualifying gate but winning — shown as promising small samples
    // (in the career view this catches hot streaks like an 8-game 88% hero).
    const promising = [...byHero.values()]
      .filter(h => h.games >= 3 && h.games < minGames && h.win / h.games >= 0.6)
      .sort((a, b) => (b.win / b.games) - (a.win / a.games))
      .slice(0, 4);
    const promisingLine = promising.length
      ? (await Promise.all(promising.map(async h => `${await dotaDataService.getHeroName(h.heroId)} (${h.win}-${h.games - h.win})`))).join(' · ')
      : '';

    const spanDays = windowDays === Infinity ? 'all available' : `last ${windowDays}d`;
    const embed = new EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle(`⚡ Top Turbo Heroes: ${targetUser.username}`)
      .setDescription(
        `📅 **${spanDays}** (from last game) · baseline WR **${Math.round(baselineWR * 100)}%** over ${totalGames} games\n`
        + `Ranked by **sample-adjusted win rate** (${shrinkK} baseline pseudo-games). Min ${minGames} games. Impact is role-aware context.`,
      )
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(heroLines.length ? heroLines : [{ name: 'Not enough data', value: `No hero with ${minGames}+ turbo games in this window. Try \`+topheros all\`.`, inline: false }]);

    if (promisingLine) embed.addFields({ name: `🌱 Promising — small sample (under ${minGames} games)`, value: promisingLine, inline: false });

    embed
      .setFooter({ text: `Steam ID: ${user.steamId} · role = your actual position · +topheros 90 / all (window) · top10 (more heroes)` })
      .setURL(`https://www.opendota.com/players/${user.steamId}/heroes?game_mode=23`)
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error(`Error in tophero command for ${discordId}:`, error);
    if (error instanceof Error && (error as any).response?.status === 404) {
      return message.reply('Player not found. Make sure the Steam ID is correct and the profile is public.');
    }
    return message.reply('An error occurred while fetching turbo heroes. Please try again later.');
  }
}
