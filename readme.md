# Doto Tracker

Doto Tracker is a powerful Discord bot designed to enhance the Dota 2 gaming experience for Discord communities. It provides real-time match statistics, player tracking, and AI-powered chat interactions.

## Features

- **Player Registration**: Users can register their Steam IDs with the bot.
- **Recent Match Stats**: Fetch and display detailed statistics for recent Dota 2 matches.
- **Auto-Show Toggle**: Users can enable or disable automatic match result sharing.
- **AI-Powered Chat**: Engage with an anime-girl assistant powered by GPT-3.5.
- **Multi-Player Match Summary**: Comprehensive scoreboard for matches with multiple registered players.
- **Hero and Item Information**: Detailed hero and item data for each match.

## Commands

- `+register <steam_id>`: Register your Steam ID with the bot.
- `+rs [@user]`: Show your or mentioned user's most recent match stats.
- `+toggleauto`: Toggle automatic sharing of your recent matches.
- `+unregister`: Remove your Steam ID from the bot's database.
- `+gpat <prompt>`: Interact with the AI-powered anime girl assistant.
- `+gpatclear`: Clear your AI conversation history.
- `+caow`: Get a fun response from the bot.
- `+help`: Display the list of available commands.

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/doto-tracker.git
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file in the root directory with the following content:
   ```
   BOT_TOKEN=your_discord_bot_token
   OPENROUTER_API_KEY=your_openrouter_api_key
   ```

4. Build and start the bot:
   ```
   npm start
   ```

## Technologies Used

- TypeScript
- Discord.js
- Axios
- OpenDota API
- OpenRouter AI API

## Project Structure

- `src/`: Source code directory
  - `commands/`: Individual command handlers
  - `constants/`: Constant values and configurations
  - `models/`: TypeScript interfaces for data models
  - `services/`: Core services for bot functionality
  - `utils/`: Utility functions
- `dist/`: Compiled JavaScript output
- `users.json`: User data storage file

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the ISC License.

## Acknowledgements

- OpenDota for providing the Dota 2 match data API
- OpenRouter for the AI chat capabilities
- The Discord.js team for their excellent library
