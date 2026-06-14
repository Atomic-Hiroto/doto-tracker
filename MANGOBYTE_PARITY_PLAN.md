# Doto Tracker — MangoByte Parity & Polish Plan

**Goal:** Make Doto Tracker a strict superset of [MangoByte](https://github.com/mdiller/mangobyte) for a Dota group that wants tracking, accountability, coaching, and improvement — so MangoByte becomes a smaller subset of what we do, not a replacement.

**Strategy:** Keep our moat (auto match loop, Turbo community stats, fact-grounded AI analysis, persistent coaching) and absorb MangoByte's broad-utility strengths (reference data, visual match tools, flexible match filters, slash-command UX) — without becoming a general clone. We deliberately **skip voice/TTS** and fluff (Pokémon, 8ball, reddit) as they change the bot's identity without serving Dota improvement.

---

## Where each bot stands

### Doto Tracker is already ahead (the moat — keep leaning in)
- Auto-posts registered users' new matches; groups co-players into one scoreboard.
- Turbo community systems: `+turbolb`, `+turbostats`, `+turbopairs`, `+myturbopairs`.
- AI far beyond MangoByte: whole-match recap, focused player coaching, Stratz + OpenDota fact grounding, cached analysis, persistent coaching plans, future-match check-ins, `+coach` trend synthesis, reply follow-ups, user context notes.
- Social loop: achievements, streaks, hero mastery, server-local comparisons.
- Coaching-oriented meta/draft tools: Dotabuff Turbo scrape, `+draft`, `+suggest`.

### MangoByte was ahead (the gaps we're closing)
| Area | MangoByte | Our gap → plan |
|---|---|---|
| Dota encyclopedia | Full Dotabase lookup | **Closed in Phase 0** (`+hero/+item/+ability/+aghs/+talents`) |
| Visual match output | Many images/GIFs | **Phase 0 + Phase 2** |
| Match filtering | Flexible filter DSL | **Phase 1** |
| Match utility cmds | graph, skillbuild, inventory, percent | **Phase 0 (graph) + Phase 2/3** |
| Slash commands | Fully migrated | **Phase 4** |
| Voice/TTS | Full subsystem | **Out of scope (deliberate)** |

---

## ✅ Phase 0 — Done

Shipped and committed this session:

- **Reference suite** — `+hero`, `+item`, `+ability`, `+aghs`, `+talents`.
  - New `src/services/referenceService.ts`: lazy-loads & 24h-caches OpenDota constants (items, abilities, hero kits, talents, `aghs_desc`) with fuzzy name matching.
  - New `src/commands/reference.ts`: rich embeds (item cost/recipe/quality colors, ability values, hero stat blocks, Scepter/Shard).
  - Collapses ~15 of MangoByte's 22 Dotabase commands. *(commit `6d7788b`)*
- **`+graph <match_id>`** — dotabuff-style diverging gold/XP advantage chart.
  - `renderMatchAdvantageGraph` in `src/services/chartService.ts` (green/red area around zero baseline, dashed XP line, minute axis, legend). *(commit `b1f2a49`)*
- **`+rs` image table** — multi-match view now renders a styled PNG (result bars, zebra rows, color-graded KDA, GPM, duration, mode) instead of plain text. *(commit `d498ba2`)*

Foundation proven: the bot renders PNGs via `@napi-rs/canvas`, so we can match any image/graph MangoByte produces.

---

## ✅ Phase 1 — Match Filter DSL  *(highest leverage; the keystone)*

The biggest practical upgrade. Unlocks smarter AI commands and is a prerequisite for Phase 3. Most filters map straight onto OpenDota `/players/{id}/matches` query params, so the API does the heavy lifting.

**1a — Shared parser** (`src/utils/matchFilter.ts`)
- Parse natural tokens → `{ openDotaParams, residualPredicates }`.
- Filters: `won` / `lost`; `turbo` / `ranked` / `unranked` / `ap`; `as <hero>`; `with <player>` / `without <player>`; time windows `today` / `this week` / `this month` / `last N days` / `since <patch>`; `last` (most recent single).
- Patch → date table built from OpenDota `/constants/patch` (for `since 7.41`).
- API params: `win`, `hero_id`, `game_mode`, `lobby_type`, `date`, `with_hero_id`/`included_account_id`/`excluded_account_id`.
- Residual (client-side) predicates for anything the API can't express.

**1b — Wire into commands**
- `+rs` — replace ad-hoc flags with the DSL (keep old flags working). e.g. `+rs won as invoker this week`.
- `+analyze` — resolve a filter to a match id. e.g. `+analyze last lost as PA`.
- `+coach` — scope the coaching corpus. e.g. `+coach turbo losses since 7.41`.

**Shipped in this pass:**
- Shared `src/utils/matchFilter.ts` parser.
- Wired into `+rs`, `+analyze`, and `+coach`.
- Old `+rs --hero/--turbo/--wins/--losses` flags are preserved by translating them into the DSL.
- Also reused by the new deterministic `+inventory`, `+roles`, and `+%` slices.

**Acceptance:** all three commands accept DSL phrases; existing syntax unaffected; parser covered by TypeScript compile and command-level validation.

---

## ✅ Phase 2 — Visual / UX parity  *(independent; interleave for quick wins)*

The canvas pipeline exists; this is mostly rendering work.

- **2a — Advantage graph in `+analyze`** — attached when OpenDota has gold/XP timeline data; unparsed matches skip it gracefully.
- **2b — Hero portrait icons** — best-effort cached remote loader for `+rs` image rows.
- **2c — `+skillbuild <match_id> <player|hero>`** — ability level-up order as a grid image from `ability_upgrades_arr`.
- **2d — Roles graph + inventory image** — `+roles`, `+inventory <match_id>`, and `+inventory [filters]` shipped.
- **2e — Embed polish pass** — help/discovery updated; analysis embeds now carry the graph visual.

---

## ✅ Phase 3 — Deterministic coaching slices  *(depends on Phase 1)*

Turn stats into accountability — built on the DSL + parsed data.

- **`+inventory [@user] [filters]`** — typical end-game items ("what do you end games with?").
- **`+% [@user] [filters] with <item>`** — e.g. `+% turbo wins as PA with BKB`.
- These slices are deterministic command outputs; they remain separate from single-match `+analyze` context to avoid poisoning focused analysis.

---

## ✅ Phase 4 — Slash commands + autocomplete

- Slash commands registered on bot ready for the main command surface.
- Prefix commands remain fully supported.
- Hero/item autocomplete via `referenceService` where Discord option shape supports it.
- Slash commands call the same command handlers through message adapters, so behavior stays consistent.

---

## ✅ Phase 5 — Help revamp + infra hardening

- Help text now documents filters and the new visual/stat commands.
- Hero images are cached in-process by URL.
- Final verification is `npx tsc --noEmit` plus `git diff --check`.

---

## Sequencing logic

1. **Phase 1 first** — keystone; Phase 3 depends on it and the AI commands get smarter immediately.
2. **Phase 2 any time** — independent; use for visible wins between functional work.
3. **Phases 4–5 last** — best once the command surface is stable.

## Out of scope (deliberate)
- Voice / TTS / audio clip subsystem — changes the bot's identity, heavy infra; conceded to MangoByte.
- Pokémon, 8ball, reddit, wikipedia, word-scramble — fluff that makes us *more* like MangoByte, not more differentiated.
