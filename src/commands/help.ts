import { EmbedBuilder, Message } from 'discord.js';
import { logger } from '../services/loggerService';

// Rich, grouped help embed. Kept in sync with the command switch in
// discordService.ts — when you add a command, add it here too.
const SECTIONS: { name: string; lines: string[] }[] = [
  {
    name: '🎮 Player & Match',
    lines: [
      '`+register <steam_id>` — link your Steam ID',
      '`+register @user <steam_id>` — link another user (owner/server manager)',
      '`+register @user <steam_id> roster-only` — private-history identity for pair/party recognition',
      '`+unregister` — unlink your Steam ID',
      '`+profile [@user]` (or `+turbostats`) — ranked medal, all-mode stats, hidden Turbo rank and pull',
      '`+rs` / `+recent [@user] [n] [filters]` — recent matches image table',
      '`+matches [@user] [n] [filters]` — pick a match → Analyze / scoreboard / links',
      '`+toggleauto` — auto-post your new matches on/off',
    ],
  },
  {
    name: '📈 Stats & Trends',
    lines: [
      '`+streak [@user]` — current win/loss streak',
      '`+trend [@user] [kda|gpm|wr]` — performance trend graph',
      '`+heroes [@user]` — most-played heroes & win rates',
      '`+compare @p1 @p2` (or `name vs name`, or just `@p` for you vs them) — side by side, with a verdict on hidden Turbo rank',
      '`+throw [@p1] [@p2] [normal] [days=90] [solo|party] [details]` — who throws more? Accepts Steam IDs/links, defaults to Turbo',
      '`+achievements [@user] [all]` — Turbo trophy case or full unlock catalog',
    ],
  },
  {
    name: '🔮 Turbo Rank',
    lines: [
      '`+turborank [@user]` — your hidden Turbo rank, read from your solo lobbies',
      '`+turborank all` (or `+turbolb`) — hidden rank leaderboard · `all everyone` adds provisional players',
      '`+turborank calibrate [@user]` — refresh from match history (everyone who played is also refreshed nightly)',
      '`+turborank audit [@user]` — every game behind the estimate',
      '`+turbolean [all]` — who plays above or below their ranked medal',
      '`+turboclimb` — biggest rank movers across calibrations',
      '`+turbowinrate [@user]` — win rate by lobby medal and party size, with ± luck ranges',
    ],
  },
  {
    name: '🤝 Turbo Parties',
    lines: [
      '`+turbopull [me|@user ...] [days]` — who brings tougher enemies when they join your party',
      '`+turboparty [me|@user ...] [days]` — strongest stacks by Party MMR, plus untried five-stacks',
      '`+turboparty wins` · `+turboparty matches` — the same stacks by win rate or by games together',
      '`+turboparty plan [@user ...]` — fill a five-stack for the easiest or toughest enemies',
      '`+turbofive [@user ...] [days]` — your best five-stack, with a position and hero for everyone',
      '`+turbopairs [me|@user] [days]` — luckiest duos with ± luck ranges · `games` for most-played · `hard` adds enemy ranks',
    ],
  },
  {
    name: '🦸 Turbo Heroes & Items',
    lines: [
      '`+topheroes [@user] [days]` — best Turbo heroes (60 days by default)',
      '`+turbometa [patch] [rank]` — best Turbo heroes per position (Stratz, Wilson-ranked) · `+meta` adds doto-chan\'s take',
      '`+turboitems [hero] [@user]` — key item timings on a hero, Turbo-adjusted',
      '`+turboherolb <hero>` — role-aware crew leaderboard for a hero',
    ],
  },
  {
    name: '🧪 Turbo Research',
    lines: [
      '`+turbostudy [crew] [full]` — how Turbo and ranked skill line up · `scorecard` checks rank accuracy · `deep` for the Stratz scan',
      '`+turbostudy heroes [medal]` — Turbo hero balance vs ranked',
      '`+turbostudy items <hero>` — crew item timing signals on a hero',
      '`+turbostudy duration [crew|90|all]` — Turbo vs normal game length',
      '`+turbobackfill [days] [per-player]` — owner-only Stratz history sync',
    ],
  },
  {
    name: '🤖 AI & Coaching',
    lines: [
      '`+analyze <match_id> [player]` — fact-grounded recap or player coaching',
      '`+analyze last lost as PA` — resolve a filter to a match, then analyze',
      '`+coach [@user] [filters]` — trend coach across recent games & saved plans',
      '`+suggest [@user]` — AI hero/build picks from your pool',
      '`+draft <enemy heroes>` — counter-pick help (`+draft Pudge, Invoker, AM`)',
      '`+topllms [n|all|audit]` — LM Council aggregate LLM benchmark leaderboard',
      '`+gpat <message>` — chat with doto-chan',
      '`+gpatclear` — clear your AI history',
      '`+togglesharedcontext <on/off>` — shared AI context in channel',
    ],
  },
  {
    name: '📚 Knowledge & Visuals',
    lines: [
      '`+hero <name>` — stats, abilities, Aghs',
      '`+item <name>` — cost, stats, recipe, effects',
      '`+ability <name>` — ability details & values',
      '`+aghs <hero>` — Scepter & Shard upgrades',
      '`+talents <hero>` — talent tree',
      '`+graph <match_id>` — gold/XP advantage graph',
      '`+skillbuild <match_id> <player|hero>` — skill order image',
      '`+inventory <match_id>` — end-game inventory image',
      '`+inventory [@user] [filters]` — common end items',
      '`+roles [@user] [filters]` — parsed role distribution graph',
      '`+%` / `+percent [@user] [filters] with <item>` — item % query',
    ],
  },
  {
    name: '🏟️ The International',
    lines: [
      '`+ti` — main-stage status: live game, latest results, open series',
      '`+ti results [n]` — recent main-stage games',
      '`+ti fantasy [core|mid|sup] [name|team] [n]` — fantasy board, ranked within each card slot',
      '`+ti teams` — main-stage game record per team',
      '`+ti scoring` — the fantasy point table and where it drifts',
      'Results post themselves in #doto-tracker as each game ends.',
    ],
  },
  {
    name: '🔎 Match Filters',
    lines: [
      'Works with `+rs`, `+recent`, `+matches`, `+analyze`, `+coach`, `+trend`, `+inventory`, `+roles`, `+%`, `+percent`.',
      'e.g. `won` · `lost` · `turbo` · `ranked` · `as invoker` · `against pudge` · `today` · `this week` · `last 30 days` · `since 7.41`',
    ],
  },
  {
    name: 'ℹ️ Other',
    lines: ['`+caow` — fun command', '`+help` — this message'],
  },
];

function addSectionFields(embed: EmbedBuilder) {
  const limit = 1000; // Discord field values cap at 1024; leave room for safety.

  for (const section of SECTIONS) {
    let chunk: string[] = [];
    let used = 0;
    let part = 1;

    const flush = () => {
      if (chunk.length === 0) return;
      embed.addFields({
        name: part === 1 ? section.name : `${section.name} (${part})`,
        value: chunk.join('\n'),
        inline: false,
      });
      chunk = [];
      used = 0;
      part++;
    };

    for (const line of section.lines) {
      const safeLine = line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
      const extra = chunk.length ? 1 : 0;
      if (used + safeLine.length + extra > limit) flush();
      chunk.push(safeLine);
      used += safeLine.length + extra;
    }

    flush();
  }
}

export async function help(message: Message) {
  try {
    const embed = new EmbedBuilder()
      .setColor('#7c3aed')
      .setTitle('🎯 Doto Tracker — Commands')
      .setDescription('Stats, visuals and AI coaching for Dota 2. Reply to any analysis embed to keep the conversation going. Local streak/turbo/achievement stats use bot-tracked matches.')
      .setFooter({ text: 'Core commands work as slash commands too • prefix: +' });

    addSectionFields(embed);

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.warn('Help embed failed, sending compact text fallback:', error);
    await message.reply(SECTIONS.map((section) => `**${section.name}**\n${section.lines.join('\n')}`).join('\n\n').slice(0, 1900));
  }
}
