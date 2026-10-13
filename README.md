<img src="assets/icon.svg" width="64" height="64" alt="">

# areadidattica

areadidattica puts your Politecnico di Torino course avvisi, school messages and deadlines behind a small JSON API on your own computer, so a dashboard, a bot or a script can read them and mark them read.

Course avvisi don't arrive by email. They live on the Portale della Didattica and in the PoliTO Students app, where they're easy to miss. areadidattica logs in to your account the way that app does, using the [API PoliTO publishes for its own apps](https://github.com/polito/api-spec), and answers on `127.0.0.1` only. It runs as one Docker container. Your password stays in a `.env` file on your machine, and nothing is hosted anywhere else. There's no account to create and nothing to pay.

> [!IMPORTANT]
> This is not an official PoliTO project. The API is meant for PoliTO's own apps and has no public developer program, so it can change without notice and break this tool until it's updated.

## What it does

1. **Logs in once.** It signs in with your student id and password, stores the token in `data/session.json`, and reuses it until PoliTO refuses it. A rejected login pauses new attempts for 5 minutes, so a wrong password can't lock your account.
2. **Reads on request.** Nothing runs in the background. Each call to `/items` reads your notifications and messages, then fetches the full text of each course avviso.
3. **Keeps the text readable.** The Italian stays as the teacher wrote it. HTML becomes plain text: links turn into `label (url)`, and a table becomes one line per row with the cells split by tabs, so an exam timetable can be shown as a table again.
4. **Marks things read.** `POST /items/{id}/read` marks an avviso or message read on PoliTO, so the phone app stops counting it too.
5. **Stays gentle on PoliTO.** It makes one call at a time, at least 250 ms apart, and caches course notice lists for 5 minutes.

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" 'http://127.0.0.1:8789/items?unread=true'
```

```json
{
  "items": [
    {
      "id": "notification:901",
      "kind": "avviso",
      "course": "System and device programming",
      "title": "Nuovo avviso da System and device programming",
      "text": "Gentili studenti,\n\nla lezione di mercoledì 14 ottobre è spostata in aula 7T, dalle 13:00 alle 14:30.",
      "sentAt": "2026-10-12T08:01:00Z",
      "isRead": false,
      "urgent": false,
      "sourceUrl": null
    }
  ]
}
```

The [API reference](docs/api.md) has every endpoint and field.

## Requirements

- Docker with Compose, to run it.
- Node.js 24 or newer, only for the tests and the live check. Node runs the TypeScript directly, so there's no build step.
- A PoliTO student account that signs in to the PoliTO Students app without MFA.

## Start

```bash
git clone https://github.com/SuperTost100/areadidattica-cli.git areadidattica
cd areadidattica
cp .env.example .env
```

Open `.env` and fill in `POLITO_USERNAME` (like `s123456`), `POLITO_PASSWORD` and `API_TOKEN`. The token is the secret your dashboard or script will send; generate one with:

```bash
openssl rand -hex 32
```

Create the data folder yourself, so it belongs to you rather than to root, then start the container:

```bash
mkdir -p data
docker compose up -d --build
```

Check that it answers:

```bash
curl -s -H "Authorization: Bearer <API_TOKEN>" http://127.0.0.1:8789/health
```

```json
{ "ok": true, "loggedIn": false, "lastError": null }
```

`loggedIn` turns `true` after the first call that needs PoliTO, like `/items`.

The port is published on `127.0.0.1` only. Another Compose project, such as a dashboard, reaches it by joining this project's network (`areadidattica_default` when the folder is called `areadidattica`) and calling `http://areadidattica:8789`.

### Try it without your account

PoliTO runs a public mock of the same API, which accepts any login and answers with example data. Set this in `.env` to try everything first:

```bash
POLITO_BASE_URL=https://app.didattica.polito.it/mock/api
```

## Use it with Grok Bot Dashboard

[Grok Bot Dashboard](https://github.com/SuperTost100/Grok-Bot-Dashboard) reads areadidattica directly. Unread avvisi become cards with the course name and a real table for timetables, and tapping "Mark as read" there marks them read here. Its README has the three lines to add to its `.env`.

## Your data

Everything stays in this folder: your credentials in `.env`, and the session token and client id in `data/session.json` (readable by you only). These are the only things that leave your computer:

- **Calls to PoliTO.** Login, notifications, messages, course notices, the course list and deadlines, all to `app.didattica.polito.it`, only when something calls this API.
- **Mark as read.** One call to PoliTO per item you mark read.

The server logs one line per request (method, path, status, time) and nothing else. It sends no telemetry.

## Does it sign you out of the phone app?

No. Tested on a real account on 2026-10-13: the phone app stayed signed in after areadidattica logged in. The code is built for that:

- It logs in with its own client id and the device name `areadidattica`, so PoliTO sees a second device, not a replacement for your phone.
- It sends no push token, so push notifications keep going to the phone only.
- It logs in once and keeps the token. Even if PoliTO allowed one session per account, the phone would be signed out at most once, not on every call.

To check it on your own account:

1. Open the PoliTO app on your phone and make sure you're signed in.
2. Run `npm run live-check -- --fresh-login` (see below).
3. Pull to refresh the notifications on your phone. If the app asks you to sign in again, logging in here signed the phone out.

## Configuration

Set these in `.env`. [`.env.example`](.env.example) has the template.

| Variable                | Required | Default                               | What it does                                      |
| ----------------------- | -------- | ------------------------------------- | ------------------------------------------------- |
| `POLITO_USERNAME`       | yes      |                                       | Your student id, like `s123456`                   |
| `POLITO_PASSWORD`       | yes      |                                       | Your PoliTO password                              |
| `API_TOKEN`             | yes      |                                       | Bearer secret for this API, 24 characters or more |
| `NOTICES_CACHE_SECONDS` | no       | `300`                                 | How long course notice lists stay cached          |
| `UPSTREAM_GAP_MS`       | no       | `250`                                 | Minimum pause between two PoliTO calls            |
| `POLITO_APP_VERSION`    | no       | `1.6.2`                               | App version sent at login                         |
| `POLITO_BUILD_NUMBER`   | no       | `1060200`                             | App build number sent at login                    |
| `POLITO_BASE_URL`       | no       | `https://app.didattica.polito.it/api` | API base; the public mock is at `/mock/api`       |
| `HOST`, `PORT`          | no       | `127.0.0.1`, `8789`                   | Where the server listens; Compose sets both       |
| `DATA_DIR`              | no       | `./data`                              | Where `session.json` lives; Compose uses `/data`  |

## Development

```bash
npm ci
npm test            # 39 tests against a fake PoliTO server, no network
npm run typecheck
```

The tests serve the JSON in [`test/fixtures/`](test/fixtures/) from a local stand-in for the PoliTO API. CI runs the same commands plus `docker build`.

`npm run live-check` calls the real PoliTO API with the credentials in `.env`. It prints counts, the notification scopes it saw and the five newest items, never the password or the token.

```bash
npm run live-check                           # reuses the stored token
npm run live-check -- --fresh-login          # forces a new login
npm run live-check -- --save fixtures-live   # also saves the raw responses
```

The saved responses hold your personal data. `fixtures-live/` is gitignored; strip names and ids before copying anything into `test/fixtures/`.

## License

MIT, see [`LICENSE`](LICENSE). The PoliTO API spec and the PoliTO apps belong to Politecnico di Torino.
