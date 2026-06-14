export const HELP = `**Available Commands:**

**🎮 Player & Match Commands:**
\`+register <steam_id>\` - Register your Steam ID
\`+unregister\` - Unregister your Steam ID
\`+profile [@user]\` - Show detailed player profile
\`+rs [@user] [n] [filters]\` - Recent match image table
\`+matches [@user] [n] [filters]\` - Pick a match to analyze from a list
\`+toggleauto\` - Toggle auto-showing of your matches

**🏆 Turbo Mode Commands:**
\`+turbolb\` - Show turbo leaderboard
\`+turbostats\` - Show your turbo stats
\`+topheros [@user]\` - Show best turbo heroes (past 4 weeks)
\`+turbopairs\` - Show best turbo duos
\`+myturbopairs\` - Show your turbo partnerships

**🤖 AI Commands:**
\`+gpat <message>\` - Chat with AI assistant (doto-chan)
\`+analyze <match_id> [player]\` - Fact-grounded match recap or player coaching
\`+analyze last lost as PA\` - Resolve filters to a match, then analyze
\`+coach [@user] [filters]\` - Persistent trend coach from recent matches and saved plans
\`+gpatclear\` - Clear your AI conversation history
\`+togglesharedcontext <on/off>\` - Toggle shared AI context in channel

**📚 Dota Knowledge Base & Visuals:**
\`+hero <name>\` - Hero overview: stats, abilities, Aghs
\`+item <name>\` - Item cost, stats, recipe and effects
\`+ability <name>\` - Ability details and values
\`+aghs <hero>\` - Aghanim's Scepter & Shard upgrades
\`+talents <hero>\` - Hero talent tree
\`+graph <match_id>\` - Gold/XP advantage graph for a match
\`+skillbuild <match_id> <player|hero>\` - Ability level-up order image
\`+inventory <match_id>\` - End-game inventory image for a match
\`+inventory [@user] [filters]\` - Common end items over recent matches
\`+roles [@user] [filters]\` - Role distribution graph
\`+% [@user] [filters] with <item>\` - Deterministic item percentage query

**🔎 Match Filters:**
Use filters with \`+rs\`, \`+analyze\`, \`+coach\`, \`+inventory\`, \`+roles\`, and \`+%\`.
Examples: \`won\`, \`lost\`, \`turbo\`, \`ranked\`, \`as invoker\`, \`against pudge\`, \`today\`, \`this week\`, \`last 30 days\`, \`since 7.41\`.

**ℹ️ Other Commands:**
\`+caow\` - Fun command
\`+help\` - Show this help message

Most commands are also available as slash commands.`;
export const CAOW = 'Thrower hai!!';
export const PROVIDE_STEAM_ID = 'Please provide your Steam ID. Usage: +register <steam_id>';
export const ALREADY_REGISTERED = (steamId: string, discordId: string) => `SteamId: ${steamId} is already registed with DiscordId: ${discordId}.`;
export const REGISTER_SUCCESS = (steamId: string) => `Successfully registered Steam ID: ${steamId}. Auto-show is enabled by default. Use +toggleauto to disable.`;
export const NOT_REGISTERED = 'You are not registered';
export const UNREGISTER_SUCCESS = (steamId: string | undefined) => `Successfully unregistered Steam ID: ${steamId}`;
export const NEED_REGISTRATION = 'You need to register first. Use +register <steam_id> to register.';
export const AUTO_SHOW_TOGGLED = (autoShow: boolean) => `Auto-show for your recent matches has been ${autoShow ? 'enabled' : 'disabled'}.`

