export const HELP = `**Available Commands:**

**🎮 Player & Match Commands:**
\`+register <steam_id>\` - Register your Steam ID
\`+unregister\` - Unregister your Steam ID
\`+rs [@user]\` - Show recent match stats
\`+toggleauto\` - Toggle auto-showing of your matches
\`+story <match_id>\` - Generate AI story for a match

**🏆 Turbo Mode Commands:**
\`+turbolb\` - Show turbo leaderboard
\`+turbostats\` - Show your turbo stats
\`+turbopairs\` - Show best turbo duos
\`+myturbopairs\` - Show your turbo partnerships

**🤖 AI Commands:**
\`+gpat <message>\` - Chat with AI assistant (doto-chan)
\`+gpatclear\` - Clear your AI conversation history
\`+togglesharedcontext <on/off>\` - Toggle shared AI context in channel

**ℹ️ Other Commands:**
\`+caow\` - Fun command
\`+help\` - Show this help message

*Need help with a specific command? Just ask!*`;
export const CAOW = 'Thrower hai!!';
export const PROVIDE_STEAM_ID = 'Please provide your Steam ID. Usage: +register <steam_id>';
export const ALREADY_REGISTERED = (steamId: string, discordId: string) => `SteamId: ${steamId} is already registed with DiscordId: ${discordId}.`;
export const REGISTER_SUCCESS = (steamId: string) => `Successfully registered Steam ID: ${steamId}. Auto-show is enabled by default. Use +toggleauto to disable.`;
export const NOT_REGISTERED = 'You are not registered';
export const UNREGISTER_SUCCESS = (steamId: string | undefined) => `Successfully unregistered Steam ID: ${steamId}`;
export const NEED_REGISTRATION = 'You need to register first. Use +register <steam_id> to register.';
export const AUTO_SHOW_TOGGLED = (autoShow: boolean) => `Auto-show for your recent matches has been ${autoShow ? 'enabled' : 'disabled'}.`

