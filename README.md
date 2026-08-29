# Pokémon Fighter — Match Server

This is the always-on server that referees real-time online battles
(both "random opponent" and "play with a friend" modes). It verifies
players are real signed-in accounts, runs the authoritative physics
and combat simulation, and reports match results directly to
Firestore — a modified game client cannot fake a win, because it
never gets to decide the outcome itself.

## One-time setup

### 1. Get a Firebase service account key

This server needs elevated access to your Firebase project (to
verify sign-in tokens and to write match results). In the
[Firebase Console](https://console.firebase.google.com):

1. Open your project → gear icon → **Project settings**.
2. Go to the **Service accounts** tab.
3. Click **Generate new private key** → confirm. A `.json` file
   downloads.
4. Open that file in a text editor and copy its **entire contents**
   (it's one JSON object).

Keep this file private — it grants full admin access to your
Firebase project. Never commit it to GitHub.

### 2. Deploy to Render

1. Push this folder to the GitHub repo you created for it.
2. In the [Render dashboard](https://dashboard.render.com), click
   **New** → **Web Service**, and connect the repo.
3. Settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free is fine to start
4. Under **Environment Variables**, add one:
   - Key: `FIREBASE_SERVICE_ACCOUNT_KEY`
   - Value: paste the *entire* contents of the JSON file from step 1
5. Click **Create Web Service**. Render will build and deploy it —
   watch the logs for `[server] listening on port ...`.
6. Your server's URL will look like
   `https://pokemon-fighter-server-xxxx.onrender.com`. The WebSocket
   URL the game client will connect to is the same address with
   `wss://` instead of `https://`.

### 3. Note the free-tier behavior

On Render's free tier, this service goes to sleep after 15 minutes
with no traffic, and takes 30–50 seconds to wake up on the next
connection. That's fine for testing and casual use. If the wake-up
delay becomes annoying once more people play, upgrading to a paid
instance (~$7/month range) keeps it running all the time.

## What this server does NOT do (by design)

- It doesn't handle matchmaking or room codes — that's Firestore's
  job on the client side, which is a separate piece of work. This
  server just needs a `roomId` and pairs up the first two players
  who show up with the same one.
- It doesn't decide coin/rank rewards for winning — it only records
  *who legitimately won* to a `matches` collection in Firestore, so
  a tampered client can't lie about the outcome. Hooking that up to
  actual in-game rewards is a follow-up step once you decide the
  numbers.
