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
      '`+profile [@user]` — detailed player profile',
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
      '`+compare @p1 @p2` — head-to-head comparison',
      '`+achievements [@user] [all]` — Turbo trophy case or full unlock catalog',
    ],
  },
  {
    name: '🏆 Turbo',
    lines: [
      '`+turbolb` — tracked turbo leaderboard',
      '`+turbostats` — your tracked turbo stats',
      '`+turbostudy` — hidden Turbo rank correlation study (`scorecard` for accuracy)',
      '`+turbostudy deep` — heavier Stratz-derived audit/form/party diagnostics',
      '`+turbostudyheroes [medal]` — Turbo hero balance vs ranked baseline',
      '`+turbostudyparty [crew]` — solo vs party contamination study',
      '`+turbostudyitems <hero>` — crew item timing signals for a Turbo hero',
      '`+turboherolb <hero>` — role-aware crew leaderboard for a Turbo hero',
      '`+turborank [@user]` — estimated hidden turbo rank',
      '`+turborank calibrate` — calibrate from match history',
      '`+turborank calibrateall` — owner-only recalibrate everyone',
      '`+turborank audit [@user]` — audit matches used by hidden rank',
      '`+turborank all` — hidden rank leaderboard',
      '`+turbolean [all]` — Turbo over/underperformers by ranked medal',
      '`+turbovs @p1 @p2` — compare two hidden Turbo profiles',
      '`+turboclimb` — biggest estimate movers over calibrations',
      '`+turbosquad @user` — frequent tracked Turbo teammates',
      '`+turbowinrate [@user|steamId]` — win rate by lobby bracket & party size',
      '`+turboitems [hero] [@user]` — key item timings on a hero (turbo-adjusted)',
      '`+durationstudy [crew|90|all]` — crew Turbo vs normal game duration study',
      '`+topheroes` / `+topheros [@user]` — best turbo heroes (60d by default)',
      '`+turbopairs [@user]` — best turbo duos (global, or a player\'s)',
      '`+turbopairs [days|alltime] [all|tracked|history]` — duo leaderboard (60 days by default)',
      '`+turboparty best [all|tracked|history]` — experimental optimal five-player party',
      '`+turbobackfill [days] [per-player]` — owner-only deduplicated Stratz history sync',
      '`+turbometa [patch] [rank]` — best turbo heroes per position (STRATZ, Wilson-ranked)',
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
      '`+meta` — AI-written turbo meta overview',
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
