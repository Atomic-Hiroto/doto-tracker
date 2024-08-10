export const HELP = 'Available commands:\n+register <steam_id> - Register your Steam ID\n+rs [@user] - Show your or mentioned user\'s most recent match stats\n+toggleauto - Toggle auto-showing of your recent matches\n+help - Show this help message';
export const CAOW = 'Thrower hai!!';
export const PROVIDE_STEAM_ID = 'Please provide your Steam ID. Usage: +register <steam_id>';
export const ALREADY_REGISTERED = (steamId: string, discordId: string) => `SteamId: ${steamId} is already registed with DiscordId: ${discordId}.`;
export const REGISTER_SUCCESS = (steamId: string) => `Successfully registered Steam ID: ${steamId}. Auto-show is enabled by default. Use +toggleauto to disable.`;
export const NOT_REGISTERED = 'You are not registered';
export const UNREGISTER_SUCCESS = (steamId: string | undefined) => `Successfully unregistered Steam ID: ${steamId}`;
export const NEED_REGISTRATION = 'You need to register first. Use +register <steam_id> to register.';
export const AUTO_SHOW_TOGGLED = (autoShow: boolean) => `Auto-show for your recent matches has been ${autoShow ? 'enabled' : 'disabled'}.`

