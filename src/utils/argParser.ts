import { Message } from 'discord.js';

export interface ParsedArgs {
    positional: string[];             // Non-flag args (e.g., "5" in "+rs 5")
    flags: Record<string, string | boolean>; // --flag value or --flag
    mentions: string[];               // Discord user IDs from mentions
}

/**
 * Parses a command's args array into structured positional, flag, and mention data.
 * Examples:
 *   +rs 5 --hero Pudge --turbo  → { positional: ['5'], flags: { hero: 'Pudge', turbo: true }, ... }
 *   +trend gpm                  → { positional: ['gpm'], flags: {}, ... }
 */
export function parseArgs(args: string[], message: Message): ParsedArgs {
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    const mentions: string[] = [];

    // Collect mention IDs
    message.mentions.users.forEach(user => mentions.push(user.id));

    let i = 0;
    while (i < args.length) {
        const arg = args[i];

        if (arg.startsWith('--')) {
            const key = arg.slice(2).toLowerCase();
            // Check if next arg is a value (not a flag itself, not a mention)
            const nextArg = args[i + 1];
            if (nextArg && !nextArg.startsWith('--') && !nextArg.startsWith('<@')) {
                flags[key] = nextArg;
                i += 2;
            } else {
                flags[key] = true;
                i++;
            }
        } else if (arg.startsWith('<@') || arg.startsWith('<#')) {
            // Skip Discord mention tokens — already captured from message.mentions
            i++;
        } else {
            positional.push(arg);
            i++;
        }
    }

    return { positional, flags, mentions };
}

/** Safe integer parse with a fallback default */
export function parseIntArg(value: string | boolean | undefined, defaultValue: number): number {
    if (typeof value === 'string') {
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? defaultValue : parsed;
    }
    return defaultValue;
}
