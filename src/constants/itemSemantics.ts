import type { ItemConstant, ItemAbility } from '../services/referenceService';

// Item FUNCTION descriptions for +analyze.
//
// Why this exists AND why it is NOT a hand-written list: the analysis prompt
// forbids the model from inventing match EVENTS, but it must still know what an
// item DOES to reason correctly. The first attempt hard-coded these meanings from
// model memory — which immediately encoded a stale fact (it claimed Nullifier
// "mutes", a mechanic Valve removed in patch 7.25). Authoring a "ground truth"
// from an LLM's recall just launders a hallucination behind an authoritative label.
//
// So the real source of truth is the live Dota 2 game constants the bot already
// loads (OpenDota /constants/items, refreshed every 24h). These descriptions come
// from Valve's own ability tooltips and update with every patch automatically.

function cleanTooltip(text: string): string {
    return String(text || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')   // strip any markup tags
        .replace(/%[^%]*%/g, '')   // drop unresolved %template% tokens
        .replace(/\\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Build a one-line FUNCTION description for an item from its real game-constant
 * ability tooltips (active/passive). Returns null when the item has no usable
 * description. Never invents behavior — it only relays Valve's current text.
 */
export function describeItemFunction(item: ItemConstant): string | null {
    const parts = (item.abilities || [])
        .filter((ability: ItemAbility) => !!ability?.description)
        .slice(0, 2)
        .map((ability: ItemAbility) => {
            const desc = cleanTooltip(ability.description || '').slice(0, 240);
            return ability.type ? `${ability.type}: ${desc}` : desc;
        })
        .filter(Boolean);
    if (!parts.length && item.notes) {
        const note = cleanTooltip(item.notes).slice(0, 240);
        if (note) parts.push(note);
    }
    return parts.length ? parts.join(' / ') : null;
}
