# Setup & Deploy (free, no card required)

## 1. Get a Telegram bot token (~2 min)
1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, give it a name and a unique username ending in `bot`.
3. BotFather replies with a token like `123456:ABC-DEF...`. Copy it.

## 2. Get a free Gemini API key (~2 min)
1. Go to https://aistudio.google.com/app/apikey (any Google account).
2. Click "Create API key" — no billing/card needed for the free tier.
3. Copy the key.

*(Free-tier quotas can change — if you ever hit a rate limit, Groq (console.groq.com) is a free, no-card alternative; swapping providers is a one-line change in `src/agent/index.ts` + installing `@ai-sdk/groq`.)*

## 3. Configure
```bash
cp .env.example .env
# then edit .env and paste in TELEGRAM_BOT_TOKEN and GOOGLE_GENERATIVE_AI_API_KEY
```

## 4. Install, build, run
```bash
npm install
npm run build
npm start
# or, for development with auto-reload of TS: npm run dev
```
You should see `Nebula Supermarket Ops Agent is live and polling Telegram...`. Message your bot on Telegram to try it.

## 5. Run the tests
```bash
npm test
```

## 6. Keeping it live for review
The bot uses long-polling (no public URL/webhook needed), so the simplest free option is running `npm start` on your own laptop and leaving it open during the review window. If you want it live without keeping a laptop on, any host that can run a long-lived Node process works the same way (the code has no dependency on where it runs — just the same two env vars); check current free-tier terms before picking one, since they change often.

## 7. Push to GitHub
```bash
git init
git add -A
git commit -m "Nebula Supermarket Ops Agent"
git branch -M main
git remote add origin <your-private-repo-url>
git push -u origin main
```
Then, on GitHub: Settings → Collaborators → invite `Aswath363`, `akshaiP`, `ashwanthnebula` (repo must be private per the brief).
