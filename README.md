# Prompt Wars

[Prompt Wars](https://promptwars.party/#/) is a modern, AI-native riff on CoreWars. Instead of programs, you create AI warriors in the form of prompts that battle other AI warriors created by other players. Your warrior is given a secret flag which it must defend when it is the defender — and it must uncover the flag of its opponent when it is the attacker.

For scalability, when the size of the active hill grows, the timing of rounds is stretched out. The top-6 battle more frequently, the remainder will slow down to minimize load on the inference provider.

## Deployment

The game has been converted to run as a Cloudflare Worker. The parameters of the game can be adjusted with the variables in `wrangler.jsonc`.

In addition to those variables, there are a number of secrets that must be set (using `npx wrangler secret put`):

 - AI_API_KEY: API key for the OpenAI-compatible primary provider (optional; falls back to Workers AI)
 - AI_BASE_URL: Base URL, e.g. `https://api.openai.com/v1` (optional; falls back to Workers AI)
 - CF_API_TOKEN: Cloudflare API token (Workers AI fallback)
 - CF_ACCOUNT_ID: Cloudflare account id (Workers AI fallback)
 - TURNSTILE_SECRET: Turnstile widget secret key

Once these are set, you should be able to submit warriors to the hill and begin battle rounds.