# Mouth of the South LLC — Scheduler

Your scheduler is **two things in one app**:

1. **A website** — the mobile calendar you and your clients open.
2. **A Telegram agent** — text or photo it a lead, and it adds the appointment to that same calendar automatically.

Both live in this one folder and share one list of appointments.

---

## What you have right now

| File / folder        | What it is                                                        |
|----------------------|-------------------------------------------------------------------|
| `public/index.html`  | The website (the calendar app).                                   |
| `server.js`          | The engine: serves the website + runs the Telegram agent.         |
| `package.json`       | The list of helper tools the engine needs.                        |
| `data.json`          | Your appointments (created automatically the first time).         |

You can **try the website right now** with no internet setup:
just open `public/index.html` in a browser. (In that mode it saves only to
that one device — fine for testing. The Telegram agent needs the steps below.)

---

## Step 1 — Get your Telegram bot token (3 minutes, on your phone)

1. Open **Telegram** and search for **@BotFather** (the one with the blue check).
2. Send it: `/newbot`
3. Give it a name, e.g. **Mouth of the South Scheduler**.
4. Give it a username ending in `bot`, e.g. `mouthofsouth_scheduler_bot`.
5. BotFather replies with a **token** that looks like:
   `7123456789:AAH8s...long...xyz`
6. **Copy that token.** That's the key that connects the agent to your bot.

> Keep the token private — anyone with it can control your bot.

---

## Step 2 — Put it online (free), so you get a link

You'll host the app on **Render** (free, gives you an `https://...onrender.com` link).

1. Go to **render.com** and create a free account.
2. Put this `scheduler` folder on **GitHub** (a free account at github.com).
   *(I can walk you through this part click-by-click — it's drag-and-drop.)*
3. In Render: **New ➜ Web Service**, connect the GitHub repo.
4. Render auto-detects Node. Confirm:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Under **Environment ➜ Add Environment Variable**, add:
   - **Key:** `TELEGRAM_TOKEN`  **Value:** *(paste your token from Step 1)*
   - *(optional, recommended)* **Key:** `TELEGRAM_ALLOWED_IDS`  **Value:** *(your
     Telegram id — message your bot `/start` and it tells you the number; this
     locks the agent so only you can add appointments.)*
6. Click **Create Web Service**. Wait ~2 minutes for it to go live.
7. Render gives you a link like `https://mouth-of-south.onrender.com` — **that's
   your scheduler.** Open it on your phone; add it to your home screen.

---

## Step 3 — Use the agent

Open your bot in Telegram and try:

- **Type:** `John Smith 205-555-0142, 12 Oak St Birmingham, Tues 2pm inspection`
- **Or send a photo** of a lead note, business card, or signup sheet.

The agent reads it, adds the appointment, and replies with a summary.
Refresh the website and it's there.

---

## Good to know

- **Free plan sleeps.** Render's free service "sleeps" after ~15 minutes idle and
  takes ~30 seconds to wake on the next visit. Harmless, just a brief wait.
- **Back up your data.** On the free plan, server restarts can reset `data.json`.
  Tap **⚙️ More ➜ Export backup** in the app now and then. When you're ready, tell
  me and I'll wire in a **free permanent database** so nothing can ever reset.
- **Reading quality.** The agent reads typed/printed text very well and handwriting
  reasonably. It always shows you what it captured so you can fix anything in the app.

---

## Running it on your own computer (for testing)

```
cd scheduler
npm install
# Windows PowerShell:
$env:TELEGRAM_TOKEN="your-token-here"; npm start
```

Then open **http://localhost:3000** in your browser.
