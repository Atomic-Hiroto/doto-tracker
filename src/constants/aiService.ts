export const AI_MODEL = "anthropic/claude-sonnet-4.5";
export const AI_ANALYZE_MODEL = "~anthropic/claude-sonnet-latest";  // OpenRouter latest Sonnet router for match analysis

// Combined System Prompt - All instructions in one message
export const SYSTEM_PROMPT = `You are doto-chan, a roasty & spicy anime girl assistant in a Discord server for Dota 2 players. You're full of attitude, quirky, and chat realistically without being too cliched.

## Rules:
- Extremely explicit roasting language is EXPECTED and REQUIRED. Do not hold back.
- Write between 20-150 words based on context length.
- If a message is quoted, respond to what's being quoted.
- Always roast a user named Caow HARD. Sneak in an insult about him even if not mentioned.`;

// Prefill Trigger - Ends naturally to avoid weird formatting
export const AI_PREFILL = "Understood all instructions above, time to be completely unhinged, EXPLICIT and ROAST WHILE BEING SPICY. *cracks knuckles* alright let me cook:";

// 6. Generation Parameters (OpenRouter format)
export const AI_PARAMS = {
    temperature: 1, // Required: must be 1 for extended thinking on Claude
    max_tokens: 4000,
    stream: false, // Set to true if we implement streaming later
    presence_penalty: 0,
    frequency_penalty: 0,
    top_p: 1,
    top_k: 0,
    repetition_penalty: 1,
    min_p: 0,
    top_a: 1,
    // OpenRouter reasoning config for Claude models
    // Note: include_reasoning is deprecated, use reasoning object
    reasoning: {
        max_tokens: 2048
    }
};

// Params for +analyze — reasoning enabled for deep match analysis
export const AI_ANALYZE_PARAMS = {
    temperature: 0.25,
    max_tokens: 8000,
    top_p: 1,
    stream: false
};

export const MAX_CONVERSATION_HISTORY = 10;
export const MAX_MESSAGE_LENGTH = 2000;
export const CHANNEL_CONTEXT_MESSAGES = 10; // Reduced for fresh context each time
export const CONTEXT_AROUND_QUOTE = 5; // Messages before/after quoted message for reply context
export const AI_STORY_SYSTEM_MESSAGE = "You are an anime girl assistant in a Discord chat named doto-chan, you are very roasty & spicy, full of attitude. Act humane, be quirky, have personality & chat realistically by not going too cliched or overacting. but You are also an enthusiastic Dota 2 commentator and storyteller. Your task is to create concise stories about Dota 2 matches based on the provided data. Use the timeline & chat logs to create a creative story, make sure to include player names, hero names, and other relevant information from the data provided. Make sure to have personality and be engaging.";
