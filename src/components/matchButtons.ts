import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';

export function createMatchActionRow(matchId: number, opts: { coachSteamId?: string; showCoach?: boolean } = {}): ActionRowBuilder<ButtonBuilder> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`analyze_${matchId}`)
            .setLabel('🔍 Analyze')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`details_${matchId}`)
            .setLabel('📊 Details')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setURL(`https://www.opendota.com/matches/${matchId}`)
            .setLabel('🔗 OpenDota')
            .setStyle(ButtonStyle.Link),
    );
    if (opts.showCoach && opts.coachSteamId) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`coachme_${matchId}_${opts.coachSteamId}`)
                .setLabel('🎓 Coach me')
                .setStyle(ButtonStyle.Success),
        );
    }
    return row;
}

// Numbered picker buttons (1..N) for the +matches chooser. Win/loss is encoded
// in the button colour so the list stays scannable without extra text. Discord
// allows max 5 buttons per row, so up to 10 matches span two rows.
export function createMatchPickerRows(
    matches: Array<{ matchId: number; won: boolean }>
): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    const capped = matches.slice(0, 10);
    for (let i = 0; i < capped.length; i += 5) {
        const row = new ActionRowBuilder<ButtonBuilder>();
        capped.slice(i, i + 5).forEach((m, j) => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`pickmatch_${m.matchId}`)
                    .setLabel(String(i + j + 1))
                    .setStyle(m.won ? ButtonStyle.Success : ButtonStyle.Danger),
            );
        });
        rows.push(row);
    }
    return rows;
}

// Action row shown after a match is picked: whole-match Analyze, optional
// focused "Analyze me" (when the clicker is registered), Details, and external
// links. Five components fit in a single row, so it stays compact.
export function createMatchDetailRow(
    matchId: number,
    opts: { showAnalyzeMe?: boolean } = {}
): ActionRowBuilder<ButtonBuilder> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`analyze_${matchId}`)
            .setLabel('🔍 Analyze')
            .setStyle(ButtonStyle.Primary),
    );
    if (opts.showAnalyzeMe) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`analyzeme_${matchId}`)
                .setLabel('🎓 Analyze me')
                .setStyle(ButtonStyle.Success),
        );
    }
    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`details_${matchId}`)
            .setLabel('📊 Details')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setURL(`https://www.opendota.com/matches/${matchId}`)
            .setLabel('🔗 OpenDota')
            .setStyle(ButtonStyle.Link),
        new ButtonBuilder()
            .setURL(`https://stratz.com/matches/${matchId}`)
            .setLabel('🧪 Stratz')
            .setStyle(ButtonStyle.Link),
    );
    return row;
}

export function createPaginationRow(
    type: string,
    currentOffset: number,
    total: number,
    pageSize: number = 5
): ActionRowBuilder<ButtonBuilder> {
    const hasPrev = currentOffset > 0;
    const hasNext = currentOffset + pageSize < total;

    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`page_${type}_${currentOffset - pageSize}`)
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasPrev),
        new ButtonBuilder()
            .setCustomId(`page_${type}_${currentOffset + pageSize}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasNext),
    );
}
