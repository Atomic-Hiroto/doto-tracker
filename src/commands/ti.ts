import { EmbedBuilder, Message } from 'discord.js';
import { ProcessConstants } from '../constants';
import { TI_FANTASY_POINTS, TI_LEAGUE_LABEL, TI_MAIN_STAGE_START } from '../constants/ti';
import { logger } from '../services/loggerService';
import { ROLE_ORDER, sortRoles, TiRole } from '../services/tiRoles';
import {
  buildSeriesGroups, displayWidth, formatDuration, getTiState, mainStageGames, padDisplay,
  postGame, seriesLabel, setTiEnabled, sweepLeague, TiFantasyRow, TiGameRecord, PostTarget,
} from '../services/tiService';

const fmt = (points: number) => Math.round(points).toLocaleString('en-US');

function target(message: Message): PostTarget | null {
  const channel = message.channel as any;
  return typeof channel?.send === 'function' ? channel as PostTarget : null;
}

interface AggregateRow {
  name: string;
  team: string;
  role: TiRole;
  total: number;
  games: number;
  best: number;
  bestHero: string;
}

function aggregate(games: TiGameRecord[]): AggregateRow[] {
  const byPlayer = new Map<string, AggregateRow>();
  for (const game of games) {
    for (const row of game.fantasy) {
      const key = row.accountId ? String(row.accountId) : `${row.name}|${row.team}`;
      const entry = byPlayer.get(key);
      if (!entry) {
        byPlayer.set(key, {
          name: row.name, team: row.team, role: row.role, total: row.points,
          games: 1, best: row.points, bestHero: row.heroName,
        });
        continue;
      }
      entry.total += row.points;
      entry.games++;
      if (row.role) entry.role = row.role;
      // Teams do get replaced mid-event; the most recent one is the useful label.
      entry.team = row.team;
      if (row.points > entry.best) { entry.best = row.points; entry.bestHero = row.heroName; }
    }
  }
  return [...byPlayer.values()].sort((a, b) => b.total - a.total);
}

function resultLine(game: TiGameRecord): string {
  const winner = game.radiantWin ? game.radiantName : game.direName;
  const loser = game.radiantWin ? game.direName : game.radiantName;
  // Kills are stored Radiant-first; print them winner-first so the numbers line
  // up with the names either side of "def.".
  const winnerKills = game.radiantWin ? game.radiantScore : game.direScore;
  const loserKills = game.radiantWin ? game.direScore : game.radiantScore;
  const mvp = [...game.fantasy].sort((a, b) => b.points - a.points)[0];
  return `**${winner}** def. ${loser} · ${winnerKills}–${loserKills} · ${formatDuration(game.duration)}`
    + (mvp ? ` · ⭐ ${mvp.name} ${fmt(mvp.points)}` : '');
}

async function status(message: Message) {
  const state = getTiState();
  const games = mainStageGames();
  const embed = new EmbedBuilder()
    .setColor(0xffb020)
    .setTitle(`🏟️ ${TI_LEAGUE_LABEL} — Main Stage`)
    .setDescription(
      games.length
        ? `**${games.length}** games posted since <t:${TI_MAIN_STAGE_START}:D>.`
        : 'No main-stage games posted yet — the poller is watching.',
    )
    .setFooter({ text: state.enabled ? 'Auto-posting is ON' : 'Auto-posting is OFF (+ti on)' })
    .setTimestamp();

  const liveIds = Object.keys(state.live);
  if (liveIds.length) {
    embed.addFields({
      name: '🔴 Live now',
      value: liveIds.map(id => `[match ${id}](https://www.opendota.com/matches/${id})`).join('\n'),
    });
  }

  const recent = games.slice(-5).reverse();
  if (recent.length) {
    embed.addFields({ name: '📋 Latest games', value: recent.map(resultLine).join('\n') });
  }

  const groups = buildSeriesGroups(games);
  const open = groups.filter(group => !group.decided);
  if (open.length) {
    embed.addFields({
      name: '⏳ Series in progress',
      value: open.map(group =>
        `${group.teams[0]} **${group.wins[group.teams[0]]}** – **${group.wins[group.teams[1]]}**`
        + ` ${group.teams[1]}  (${seriesLabel(group.seriesType)})`).join('\n'),
    });
  }

  const done = groups.filter(group => group.decided).slice(-6).reverse();
  if (done.length) {
    embed.addFields({
      name: '✅ Series decided',
      value: done.map(group => {
        const loser = group.winner === group.teams[0] ? group.teams[1] : group.teams[0];
        return `**${group.winner}** ${group.wins[group.winner!]}–${group.wins[loser]} ${loser}`;
      }).join('\n'),
    });
  }

  return message.reply({ embeds: [embed] });
}

async function results(message: Message, args: string[]) {
  const count = Math.max(1, Math.min(20, Number.parseInt(args[0], 10) || 10));
  const games = mainStageGames().slice(-count).reverse();
  if (!games.length) return message.reply('No main-stage games recorded yet.');

  return message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xffb020)
      .setTitle(`📋 ${TI_LEAGUE_LABEL} — last ${games.length} main-stage games`)
      .setDescription(games.map(game =>
        `<t:${game.startTime}:t> · ${resultLine(game)}`).join('\n'))
      .setTimestamp()],
  });
}

const ROLE_ALIASES: Record<string, TiRole> = {
  core: 'Core', carry: 'Core', pos1: 'Core',
  mid: 'Mid', pos2: 'Mid',
  off: 'Off', offlane: 'Off', pos3: 'Off',
  sup: 'Sup', supp: 'Sup', support: 'Sup', pos4: 'Sup', pos5: 'Sup',
};

async function fantasy(message: Message, args: string[]) {
  const games = mainStageGames();
  if (!games.length) return message.reply('No main-stage games recorded yet, so there is nothing to score.');

  const words = args.filter(arg => !/^\d+$/.test(arg)).map(arg => arg.toLowerCase());
  const roleWord = words.find(word => ROLE_ALIASES[word]);
  const role = roleWord ? ROLE_ALIASES[roleWord] : null;
  const filter = words.filter(word => word !== roleWord).join(' ');
  const count = Math.max(3, Math.min(30, Number.parseInt(args.find(arg => /^\d+$/.test(arg)) || '', 10) || 8));

  let rows = aggregate(games);
  if (filter) {
    rows = rows.filter(row => row.name.toLowerCase().includes(filter) || row.team.toLowerCase().includes(filter));
    if (!rows.length) return message.reply(`Nobody matching **${filter}** has played a main-stage game yet.`);
  }
  if (role) {
    rows = rows.filter(row => row.role === role);
    if (!rows.length) return message.reply(`No **${role}** players on the board yet.`);
  }

  const nameWidth = Math.max(...rows.map(row => displayWidth(row.name)), 6);
  const teamWidth = Math.max(...rows.map(row => displayWidth(row.team)), 4);
  const render = (group: AggregateRow[]) => '```\n' + group.map((row, index) =>
    `${String(index + 1).padStart(2)}. ${fmt(row.total).padStart(8)}  ${padDisplay(row.name, nameWidth)}  `
    + `${padDisplay(row.team, teamWidth)}  ${row.games}g  avg ${fmt(row.total / row.games).padStart(6)}`).join('\n') + '\n```';

  const embed = new EmbedBuilder()
    .setColor(0x4ecdc4)
    .setTitle(`⭐ Main-stage fantasy${role ? ` — ${role}` : ''}${filter ? ` — ${filter}` : ''}`)
    .setFooter({ text: `Across ${games.length} games · OpenDota estimate, see +ti scoring` })
    .setTimestamp();

  // One board per card slot. A support's total is not comparable with a core's,
  // because two of the stats supports earn are invisible to OpenDota.
  if (role || filter) {
    embed.setDescription(render(rows.slice(0, count)));
  } else {
    const slots = [...new Set(rows.map(row => row.role))].sort(sortRoles);
    for (const slot of slots.filter(entry => ROLE_ORDER.includes(entry))) {
      embed.addFields({
        name: slot === 'Core' ? '🗡️ Core' : slot === 'Mid' ? '🔮 Mid' : slot === 'Off' ? '🛡️ Offlane' : '🩹 Support',
        value: render(rows.filter(row => row.role === slot).slice(0, count)),
      });
    }
    if (!embed.data.fields?.length) embed.setDescription(render(rows.slice(0, count)));
  }
  return message.reply({ embeds: [embed] });
}

async function teams(message: Message) {
  const games = mainStageGames();
  if (!games.length) return message.reply('No main-stage games recorded yet.');
  const record: Record<string, { wins: number; losses: number }> = {};
  for (const game of games) {
    const winner = game.radiantWin ? game.radiantName : game.direName;
    const loser = game.radiantWin ? game.direName : game.radiantName;
    (record[winner] ||= { wins: 0, losses: 0 }).wins++;
    (record[loser] ||= { wins: 0, losses: 0 }).losses++;
  }
  const rows = Object.entries(record).sort((a, b) =>
    (b[1].wins - b[1].losses) - (a[1].wins - a[1].losses) || b[1].wins - a[1].wins);
  const width = Math.max(...rows.map(([name]) => name.length));
  return message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xffb020)
      .setTitle(`🏅 ${TI_LEAGUE_LABEL} — main-stage game record`)
      .setDescription('```\n' + rows.map(([name, wl]) =>
        `${name.padEnd(width)}  ${wl.wins}W–${wl.losses}L`).join('\n') + '\n```')
      .setFooter({ text: 'Games won, not series won' })
      .setTimestamp()],
  });
}

function scoring(message: Message) {
  const p = TI_FANTASY_POINTS;
  return message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x4ecdc4)
      .setTitle('📐 How these fantasy points are worked out')
      .setDescription(
        'The TI 2026 table, applied per game from OpenDota\'s parsed replay. A series card counts a '
        + 'player\'s **two best games**, so a 3–0 is worth the same as a 2–0.',
      )
      .addFields(
        {
          name: 'Point values',
          value: '```\n'
            + `kill               ${p.kill}\n`
            + `death              ${p.deathBase} - ${p.deathPenalty} each\n`
            + `creep (LH+DN)      ${p.creep}\n`
            + `GPM                ${p.gpm} per point\n`
            + `tower              ${p.tower}\n`
            + `observer ward      ${p.wardPlaced}\n`
            + `camp stacked       ${p.campStacked}\n`
            + `rune               ${p.rune}\n`
            + `lotus              ${p.lotus}\n`
            + `smoke used         ${p.smoke}\n`
            + `teamfight (full)   ${p.teamfight}\n`
            + `stun (per second)  ${p.stunSecond}\n`
            + `first blood        ${p.firstBlood}\n`
            + `tormentor          ${p.tormentor}\n`
            + `roshan             ${p.roshan}\n`
            + `courier            ${p.courier}\n`
            + '```',
        },
        {
          name: '⚠️ Three stats are missing, and they are not missing evenly',
          value: `**Watchers** (${p.watcher} each) appear nowhere in OpenDota's match data — nor in Stratz's. `
            + `**Madstones** (${p.madstone}) are not counted either, only bundle uses. **Lotuses** (${p.lotus}) `
            + 'are inferred from Famangos in the purchase log, which undercounts them.\n\n'
            + 'Two of those three are support work, so **supports lose more than cores do** — the shortfall '
            + 'is plausibly 10–20% for a core and can exceed a third for a support. That is enough to reorder '
            + 'a mixed board, which is why every listing here ranks **within a card slot** and never across them.',
        },
        {
          name: '✅ What it is good for',
          value: 'Comparing players in the **same slot**, and tracking form across the event. '
            + 'Treat it as a strong estimate of a real card, not the card itself.',
        },
      )],
  });
}

export async function ti(message: Message, args: string[] = []) {
  try {
    const sub = (args[0] || '').toLowerCase();
    const rest = args.slice(1);
    const isOwner = message.author.id === ProcessConstants.BOT_OWNER_ID;

    switch (sub) {
      case '':
      case 'status':
        return status(message);
      case 'results':
      case 'games':
        return results(message, rest);
      case 'fantasy':
      case 'fp':
        return fantasy(message, rest);
      case 'teams':
      case 'standings':
        return teams(message);
      case 'scoring':
      case 'formula':
        return scoring(message);
      case 'on':
      case 'off': {
        if (!isOwner) return message.reply('Only the bot owner can toggle TI auto-posting.');
        setTiEnabled(sub === 'on');
        return message.reply(`TI auto-posting is now **${sub.toUpperCase()}**.`);
      }
      case 'backfill':
      case 'sweep': {
        if (!isOwner) return message.reply('Only the bot owner can run a TI backfill.');
        const channel = target(message);
        if (!channel) return message.reply('This channel cannot be posted into.');
        const notice = await message.reply('Sweeping the main stage for anything not yet posted…');
        const posted = await sweepLeague(channel, 40);
        return notice.edit(posted
          ? `Posted **${posted}** main-stage game${posted === 1 ? '' : 's'}.`
          : 'Nothing new — every main-stage game is already in this channel.');
      }
      case 'post': {
        if (!isOwner) return message.reply('Only the bot owner can force a TI post.');
        const matchId = Number.parseInt(rest[0], 10);
        if (!Number.isFinite(matchId)) return message.reply('Usage: `+ti post <matchId>`');
        const channel = target(message);
        if (!channel) return message.reply('This channel cannot be posted into.');
        const game = await postGame(channel, matchId, { repost: true });
        return game ? undefined : message.reply(`Could not post match ${matchId} — check it belongs to ${TI_LEAGUE_LABEL}.`);
      }
      default:
        return message.reply(
          '`+ti` status · `+ti results [n]` · `+ti fantasy [name|team] [n]` · '
          + '`+ti teams` · `+ti scoring`',
        );
    }
  } catch (error) {
    logger.error('Error in +ti command:', error);
    return message.reply('Something broke while reading the TI board. Try again in a moment.');
  }
}

export type { TiFantasyRow };
