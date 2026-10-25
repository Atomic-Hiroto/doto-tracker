# Doto Tracker

A Discord bot for Dota 2 friend groups. Register your Steam account and the bot posts your matches as they finish, keeps streaks and trends, settles arguments with head-to-head stats, and runs a deep set of Turbo studies (ranks, party synergy, item and hero meta). Optional AI commands explain a match or coach you on it.

## Run your own copy

You need Node.js 20 or newer and a Discord bot token.

1. **Create the bot.** In the [Discord developer portal](https://discord.com/developers/applications), make an application, add a bot, and turn on the **Message Content** intent. Invite it to your server with the `bot` scope and the Send Messages, Embed Links, Attach Files and Add Reactions permissions.
2. **Install.**
   ```sh
   git clone https://github.com/Atomic-Hiroto/doto-tracker.git
   cd doto-tracker
   npm install
   cp .env.example .env
   ```
3. **Configure.** Put your bot token in `.env` as `BOT_TOKEN`. Set `BOT_OWNER_ID` to your own Discord user id (Developer Mode, then right-click your name, Copy User ID) so the admin commands work for you. Everything else is optional; see the comments in `.env.example`.
4. **Start.**
   ```sh
   npm start
   ```
   This compiles TypeScript into `dist/` and starts the bot. In your server, type `+help`.

### Optional keys

| Key | What it unlocks |
|---|---|
| `OPENROUTER_API_KEY` | `+gpat`, `+analyze`, `+coach`, `+story` |
| `STRATZ_API_KEY` | Richer match detail for `+analyze` and the Stratz-based studies |
| `OPENDOTA_API_KEY` | Higher OpenDota rate limits. Without it the bot stays inside the free daily budget |

## Using it

- `+register <steam_id>` links your Steam account. A friend id, a 64-bit Steam id, or a Steam, Dotabuff, OpenDota or Stratz profile link all work.
- The bot answers in every channel until you run `+setchannel` (owner only) somewhere. After that it only answers in the channels you've set.
- `+rs` shows your latest match. `+toggleauto` turns automatic posting on or off for you.
- `+help` lists everything else: streaks, trends, `+compare`, `+throw`, achievements, and the `+turbo…` family.

Match data comes from [OpenDota](https://www.opendota.com). A player's matches only show up if their Dota profile has **Expose Public Match Data** turned on.

## Where it keeps data

Everything lives in the project folder, and all of it is gitignored:

| File | Contents | Override |
|---|---|---|
| `users.json` | Registered players | `USER_DATA_FILE` |
| `coaching.sqlite` | AI analyses, coaching plans and player notes | `COACHING_DB_FILE` |
| `channelData.json` | Per-channel settings | |
| `tiState.json` | The International poster state | `TI_STATE_FILE` |
| `dotaConstants.json` | Cached hero and item data | `DOTA_CONSTANTS_CACHE` |

## Deploying to a server

Any always-on Linux box works. Clone the repo there, fill in `.env`, run it under systemd (or pm2) as a service called `doto-tracker`, then deploy updates from Windows. Add your server to your local `.env` (the key line is optional):

```sh
DOTO_DEPLOY_HOST=ubuntu@your-server
DOTO_DEPLOY_KEY=C:\path\to\your-key
```

Then run `npm run remote-deploy`.

## Project layout

- `src/commands/` one file per command
- `src/services/` Discord, OpenDota, Stratz, AI and storage services
- `src/constants/` config read from the environment
- `scripts/` probes, simulations and test harnesses used while building the Turbo studies

## License

ISC
