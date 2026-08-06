/** Discord rejects an embed containing any field value longer than this. */
export const EMBED_FIELD_LIMIT = 1024;
/** Discord rejects a *message* whose embed title + description + all field text exceeds this. */
export const EMBED_TEXT_LIMIT = 6000;

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * Last line of defence on Discord's embed size caps.
 *
 * A single oversized field — or a total that creeps past 6000 characters — makes the
 * API reject the *entire* embed, so a report that grows one line too long fails as "an
 * error occurred" with nothing rendered. `+turbostudy` shipped that bug twice.
 *
 * Every field goes through here, and the total budget is spent from the bottom of the
 * report upward, so a formatting change can only ever cost a truncated trailing
 * paragraph — never the headline numbers, and never the whole message.
 *
 * @param reserve characters already spent on the embed's title and description.
 */
export function safeFields(fields: EmbedField[], reserve = 0): Required<EmbedField>[] {
  const out = fields.map((f) => ({
    name: f.name.slice(0, 256),
    value: f.value && f.value.length > 0
      ? (f.value.length > EMBED_FIELD_LIMIT ? `${f.value.slice(0, EMBED_FIELD_LIMIT - 9)}\n…(cut)` : f.value)
      : '—',
    inline: f.inline ?? false,
  }));

  const budget = EMBED_TEXT_LIMIT - 100 - reserve; // 100 = margin for future chrome
  let total = out.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  for (let i = out.length - 1; i >= 0 && total > budget; i--) {
    const keep = out[i].value.length - (total - budget) - 8;
    const next = keep > 0 ? `${out[i].value.slice(0, keep)}\n…(cut)` : '—';
    total -= out[i].value.length - next.length;
    out[i].value = next;
  }
  return out;
}
