import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';

export function createMatchActionRow(matchId: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`story_${matchId}`)
            .setLabel('📖 Story')
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
