import { EmbedBuilder, Message } from 'discord.js';

// Rich, grouped help embed. Kept in sync with the command switch in
// discordService.ts — when you add a command, add it here too.
const SECTIONS: { name: string; lines: string[] }[] = [
  {
    name: '🎮 Player & Match',
    lines: [
      '`+register <steam_id>` — link your Steam ID',
      '`+unregister` — unlink your Steam ID',
      '`+profile [@user]` — detailed player profile',
      '`+rs [@user] [n] [filters]` — recent matches image table',
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
      '`+achievements [@user]` — unlocked achievements',
    ],
  },
  {
    name: '🏆 Turbo',
    lines: [
      '`+turbolb` — turbo leaderboard',
      '`+turbostats` — your turbo stats',
      '`+topheros [@user]` — best turbo heroes (4 weeks)',
      '`+turbopairs` — best turbo duos',
      '`+myturbopairs` — your turbo partnerships',
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
      '`+meta` — current turbo meta tiers by lane',
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
      '`+roles [@user] [filters]` — role distribution graph',
      '`+% [@user] [filters] with <item>` — item % query',
    ],
  },
  {
    name: '🔎 Match Filters',
    lines: [
      'Works with `+rs`, `+matches`, `+analyze`, `+coach`, `+trend`, `+inventory`, `+roles`, `+%`.',
      'e.g. `won` · `lost` · `turbo` · `ranked` · `as invoker` · `against pudge` · `today` · `this week` · `last 30 days` · `since 7.41`',
    ],
  },
  {
    name: 'ℹ️ Other',
    lines: ['`+caow` — fun command', '`+help` — this message'],
  },
];

export async function help(message: Message) {
  const embed = new EmbedBuilder()
    .setColor('#7c3aed')
    .setTitle('🎯 Doto Tracker — Commands')
    .setDescription('Stats, visuals and AI coaching for Dota 2. Reply to any analysis embed to keep the conversation going.')
    .setFooter({ text: 'Most commands work as slash commands too • prefix: +' });

  for (const section of SECTIONS) {
    embed.addFields({ name: section.name, value: section.lines.join('\n'), inline: false });
  }

  await message.reply({ embeds: [embed] });
}
