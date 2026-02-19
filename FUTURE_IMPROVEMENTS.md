# 🎮 Doto-Chan — The Ultimate Roadmap

> From a simple match tracker to the **best damn Dota 2 Discord companion** in existence.

*Last Updated: 2026-02-19 • Current Version: 1.0.0*

---

## ✅ What We Already Have (Current Strengths)

Before we dream big, here's what's **already cooking**:

| Category | Features |
|----------|----------|
| **Player Management** | `+register`, `+unregister`, `+toggleauto`, `+profile` |
| **Match Tracking** | Auto-match posting, `+rs`, combined scoreboard for group games |
| **AI Assistant** | `+gpat` chat with doto-chan (Claude Sonnet 4.5), smart context for replies & shared channels, multimodal image support, `+gpatclear` |
| **Match Stories** | `+story` — AI-generated match narratives with chat logs & objectives |
| **Turbo Analytics** | `+turbolb`, `+turbostats`, `+topheros`, `+turbopairs`, `+myturbopairs` with confidence-weighted rating system |
| **Context System** | `+togglesharedcontext` — per-channel shared/individual AI context |

---

## 🔴 Critical Technical Debt (Fix These First)

These are things that will bite us as the bot grows. Non-negotiable before adding new features.

### 1. Database Migration — Kill the JSON Files
**Current Problem**: `users.json`, `turboStats.json`, `channelData.json` are all read/written synchronously. File corruption risk on crashes. No concurrent access safety.

**Solution**:
- Migrate to **SQLite** via `better-sqlite3` (zero-config, single file, perfect for a bot this size)
- Schema: `users`, `turbo_player_stats`, `turbo_pairings`, `channel_config`, `matches`
- Add proper migrations with `umzug` or manual versioning
- Bonus: enables SQL queries for leaderboards and analytics

### 2. Hero & Item Data Caching
**Current Problem**: `getHeroName()` and `getItemName()` call the OpenDota API **on every single invocation**. The `+profile` command alone can make 4+ hero API calls. `+topheros` makes 5+. These rarely change.

**Solution**:
- Fetch hero/item data **once on startup** and store in a `Map<number, string>`
- Refresh on a 24-hour interval (heroes get added maybe twice a year)
- Saves potentially hundreds of redundant API calls per day

### 3. Remove `console.log` / `console.dir` in Production
**Current Problem**: `aiService.ts` has raw `console.log` and `console.dir` statements dumping full AI payloads (lines 289-291, 316-318, 332-334, 341). These should go through the logger.

**Solution**:
- Replace all `console.log`/`console.dir` with `logger.debug()`
- Add a `LOG_LEVEL` env variable so debug logs can be toggled
- Consider structured JSON logging for production

### 4. Duplicate `getHeroName()` Implementations
**Current Problem**: `getHeroName()` is copy-pasted in `dotaService.ts`, `profile.ts`, and `tophero.ts` — three separate, identical functions.

**Solution**:
- Create a single shared `heroService.ts` (or `dataService.ts`) with a cached `getHeroName()` and `getItemName()`
- Import everywhere, single source of truth

### 5. Error Handling & Resilience
**Current Problem**: No retry logic. If OpenDota is rate-limited or down, everything fails silently.

**Solution**:
- Add `axios-retry` with exponential backoff for all OpenDota calls
- Implement a simple circuit breaker pattern for external APIs
- Add request timeouts (currently none set)
- Graceful shutdown handler for the bot process (save data before exit)

---

## 🟡 High-Impact Features (Next Sprint)

### 6. Slash Commands Migration
**Why**: Discord is deprecating message content intent for unverified bots. Slash commands provide autocomplete, validation, and a modern UX.

**Implementation**:
- Use `discord.js` built-in `SlashCommandBuilder`
- Keep prefix commands as aliases during transition
- Add autocomplete for hero names, match IDs, and user mentions
- Register commands with `REST` API on startup

### 7. Interactive Embeds with Buttons
**Why**: Replace text-heavy responses with clickable Discord components.

**Ideas**:
- Match embeds: `[📖 Story]` `[📊 Details]` `[🔄 Refresh]`
- Leaderboard: `[◀ Prev]` `[▶ Next]` pagination
- Profile: `[⚡ Turbo]` `[🦸 Heroes]` `[📈 Trends]` tabs
- Confirmation buttons for `+register` / `+unregister`

### 8. Win/Loss Streak Detection & Announcements
**Why**: Nothing hypes up a Discord server like streak callouts.

**Implementation**:
- Track consecutive wins/losses per player in the database
- Auto-announce in channel: *"🔥 Caow is on a 7 GAME WIN STREAK! Someone stop this man!"*
- Special roasts from doto-chan when someone's on a loss streak
- Streak-specific embed colors and emojis

### 9. Match Filters & History
**Why**: `+rs` only shows the last match. Users want more.

**Commands**:
- `+rs 5` — Last 5 matches overview
- `+rs --hero "Anti-Mage"` — Filter by hero
- `+rs --turbo` — Only turbo games
- `+rs --wins` / `+rs --losses` — Filter by outcome
- Show a mini-summary table for multiple matches

### 10. Performance Trend Graphs
**Why**: Visualize improvement over time.

**Implementation**:
- Use `chart.js` + `canvas` to render graphs server-side
- Track per-match: KDA, GPM, XPM, win rate rolling average
- Commands: `+trend` (last 20 games KDA graph), `+trend gpm` (GPM over time)
- Attach rendered chart as image in embed

---

## 🟢 Medium-Priority Features (Month 2-3)

### 11. Hero Mastery & Performance Tracking
- Track per-hero stats over time (not just from OpenDota, but our own tracked matches)
- Show hero "mastery level" based on games + win rate
- `+heroes` command with sortable hero grid
- "Most improved hero this month" callout

### 12. Player Comparison
- `+compare @user1 @user2` — Side-by-side profile comparison
- Compare: overall WR, KDA, turbo rating, top heroes overlap
- Head-to-head stats if they've been in the same matches
- Beautiful dual-column embed

### 13. Enhanced AI Features (doto-chan Level Up)
- **Match Analysis**: `+analyze <match_id>` — AI breaks down what went wrong/right
- **Hero Recommendations**: `+suggest` — AI suggests heroes based on recent performance & meta
- **Draft Helper**: `+draft <enemy_heroes>` — Get counter-pick suggestions with reasoning
- **Meta Report**: `+meta` — Weekly meta snapshot with trending heroes
- **Personality Memory**: doto-chan remembers user preferences and roast targets across sessions

### 14. Achievement System
- Unlock badges for milestones:
  - 🏆 *"Century Club"* — 100 tracked matches
  - 🔥 *"On Fire"* — 5+ win streak
  - 💀 *"Feeder Redeemed"* — Win after 10+ deaths
  - 👫 *"Dynamic Duo"* — 20+ games with same partner
  - 🎯 *"Hero Specialist"* — 80%+ WR on a hero (10+ games)
- `+achievements` command to show unlocked badges
- Auto-announce new achievements in channel

### 15. Smart Notifications & Alerts
- Configurable match result filters: only announce ranked, only if someone performed well, etc.
- "Daily digest" mode — summarize all matches at end of day instead of spamming
- DM mode — users can opt to receive stats via DM instead of channel
- Quiet hours — suppress auto-posts during configured times

---

## 🔵 Ambitious Features (Quarter 2+)

### 16. Web Dashboard
- Simple companion web app showing:
  - Player profiles with charts
  - Turbo leaderboard with history
  - Match timeline & replays
  - Achievement showcase
- Auth via Discord OAuth2
- Could use Next.js or a simple Express + static frontend

### 17. Tournament System
- `+tournament create "Friday Night Turbo"` — Create custom tournaments
- Bracket generation (single/double elimination)
- Auto-track results from actual matches
- Standings, schedule, and bracket embeds
- Winner announcements with AI-generated commentary

### 18. Guild / Team System
- Create teams within the server
- Team stats, team turbo rating, team leaderboard
- Inter-team challenges and rivalries
- Team-specific roasts from doto-chan

### 19. Multi-Server Support
- Per-server configuration (prefix, features, channels)
- Server-specific leaderboards
- Cross-server stats for users registered in multiple servers
- Admin panel for bot configuration

### 20. Dota 2 Live Game Integration
- Detect when registered users are in a live game (via Steam API / Dota 2 Game Coordinator)
- Post live game notification: "⚔️ 3 of our players are in a match RIGHT NOW!"
- Post-game auto-fetch with zero delay

---

## 🛠️ Developer Experience & Quality of Life

### Code Quality
- [ ] Add ESLint + Prettier with strict TypeScript rules
- [ ] Set up Jest / Vitest for unit tests (target: services first)
- [ ] Add integration tests for OpenDota API mocking
- [ ] CI/CD pipeline (GitHub Actions: lint → test → build)
- [ ] Docker containerization for consistent deployments
- [ ] `.env.example` with all required variables documented

### Architecture Improvements
- [ ] Extract a shared `DataService` for hero/item lookups (kills duplicate code)
- [ ] Create a `CommandHandler` base class/interface for consistent patterns
- [ ] Implement a proper event bus for cross-service communication
- [ ] Add request queuing for OpenDota API (respect rate limits)
- [ ] Move conversation history to persistent storage (currently lost on restart)
- [ ] Add graceful shutdown handler (save all JSON data before process exit)

### Monitoring & Observability
- [ ] Structured logging with request correlation IDs
- [ ] Command usage analytics (which commands are popular)
- [ ] API call metrics (latency, error rates, rate limit hits)
- [ ] Health check endpoint for uptime monitoring
- [ ] Error alerting (DM admin on critical failures)

---

## 📋 Implementation Priority Matrix

| # | Feature | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| 1 | Database Migration (SQLite) | 🔥🔥🔥 | Medium | 🔴 Do Now |
| 2 | Hero/Item Data Caching | 🔥🔥🔥 | Low | 🔴 Do Now |
| 3 | Clean up console.log | 🔥🔥 | Low | 🔴 Do Now |
| 4 | Deduplicate getHeroName | 🔥🔥 | Low | 🔴 Do Now |
| 5 | Error Handling / Retry | 🔥🔥🔥 | Medium | 🔴 Do Now |
| 6 | Slash Commands | 🔥🔥🔥 | Medium | 🟡 Next Sprint |
| 7 | Interactive Buttons | 🔥🔥 | Medium | 🟡 Next Sprint |
| 8 | Streak Detection | 🔥🔥🔥 | Low | 🟡 Next Sprint |
| 9 | Match Filters & History | 🔥🔥 | Medium | 🟡 Next Sprint |
| 10 | Performance Graphs | 🔥🔥 | High | 🟡 Next Sprint |
| 11 | Hero Mastery | 🔥🔥 | Medium | 🟢 Month 2-3 |
| 12 | Player Comparison | 🔥🔥 | Medium | 🟢 Month 2-3 |
| 13 | Enhanced AI | 🔥🔥🔥 | High | 🟢 Month 2-3 |
| 14 | Achievements | 🔥🔥🔥 | High | 🟢 Month 2-3 |
| 15 | Smart Notifications | 🔥🔥 | Medium | 🟢 Month 2-3 |
| 16 | Web Dashboard | 🔥🔥 | Very High | 🔵 Q2+ |
| 17 | Tournament System | 🔥🔥 | Very High | 🔵 Q2+ |
| 18 | Guild System | 🔥 | High | 🔵 Q2+ |
| 19 | Multi-Server | 🔥🔥 | High | 🔵 Q2+ |
| 20 | Live Game Integration | 🔥🔥🔥 | Very High | 🔵 Q2+ |

---

## 💡 Quick Command Reference (Proposed New Commands)

```
+rs 5                          # Last 5 matches overview
+rs --hero "Pudge"             # Filter by hero
+trend                         # Performance graph (last 20 games)
+compare @user1 @user2         # Side-by-side comparison
+streak                        # Current win/loss streak
+heroes                        # Full hero stats grid
+achievements                  # Show unlocked badges
+analyze <match_id>            # AI match analysis
+suggest                       # AI hero recommendation
+draft <enemy_heroes>          # Counter-pick helper
+meta                          # Current meta trends
+tournament create "Name"      # Tournament management
+export                        # Export your data
```

---

> *"doto-chan will become the most unhinged, stat-obsessed, roast-delivering Dota 2 companion that any Discord server has ever seen. And she'll remember to roast Caow every single time."*
> 
> — The Roadmap, probably
