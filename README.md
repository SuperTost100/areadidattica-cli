<img src="assets/icon.svg" width="64" height="64" alt="">

# areadidattica

areadidattica reads your Politecnico di Torino student account through the API behind the official PoliTO Students app and serves it as a small JSON API on `127.0.0.1`. Course avvisi, school messages and deadlines go in; normalized JSON comes out for a dashboard or bot to read.

It runs as one Docker container on your own machine, with your PoliTO credentials in `.env`. Nothing is hosted elsewhere and nothing runs in the background: each request to this service makes the PoliTO calls it needs, then stops.

Course avvisi don't arrive by email, so the PoliTO app API is the only place to read them.

## What it does

1. **Logs in once.** It calls `POST /auth/login` the way the app does and stores the token in `data/session.json` (mode `600`). It reuses that token, also across restarts, and logs in again only when PoliTO answers `401`. If PoliTO rejects the login, or refuses a token it just issued, the service stops logging in for 5 minutes. The pause is saved in `data/session.json`, so a restart doesn't lift it. A wrong password therefore costs at most one login attempt every 5 minutes; whether that is slow enough to avoid a lockout depends on PoliTO's rules, which aren't public.
2. **Fetches on request.** `GET /items` reads `/notifications` and `/messages`, keeps the course avvisi, and fetches each course's notice list for the full text. `GET /deadlines` reads `/deadlines`.
3. **Stays gentle on PoliTO.** Upstream calls run one at a time with a 250 ms gap, even when several requests arrive together. Course notice lists are cached for 5 minutes and the course list for 6 hours.
4. **Marks things read.** `POST /items/{id}/read` marks the avviso or message read on PoliTO, so the phone app shows it as read too.

Italian text stays as PoliTO wrote it. Notice HTML becomes plain text: tags go, line breaks stay, and links become `label (url)`.

## Requirements

- Docker with Compose, to run the service.
- Node.js 24 or newer, only for the tests and the live check. Node runs the TypeScript directly; there is no build step.
- A PoliTO student account that logs in to the PoliTO app without MFA.

## Start

```bash
cp .env.example .env    # fill in POLITO_USERNAME, POLITO_PASSWORD, API_TOKEN
mkdir -p data           # create it yourself so it's owned by you, not root
docker compose up -d --build
```

Generate `API_TOKEN` with `openssl rand -hex 32`. Then check it:

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8788/health
```

The port is published on `127.0.0.1:8788` only. Inside the container the server listens on `0.0.0.0`, because Docker's port mapping needs that; the mapping keeps it off the network. Another Compose project, such as the dashboard, can reach it by joining a shared Docker network and calling `http://areadidattica:8788`.

## API

Every endpoint needs `Authorization: Bearer <API_TOKEN>`; without it the answer is `401 {"error":"unauthorized"}`. Responses are JSON in UTF-8. Errors look like `{"error": "<message>"}`.

| Method | Path                | Returns                                   |
| ------ | ------------------- | ----------------------------------------- |
| `GET`  | `/items`            | `{ "items": Item[] }`, newest first       |
| `GET`  | `/deadlines`        | `{ "deadlines": Deadline[] }`, by date    |
| `POST` | `/items/{id}/read`  | `{ "ok": true, "id": "<id>" }`            |
| `GET`  | `/health`           | `{ "ok", "loggedIn", "lastError" }`       |

### `GET /items`

Returns course avvisi and school messages. Add `?unread=true` to get unread ones only. Without it you get everything PoliTO still keeps in the feed, read or not.

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

| Field       | Type                      | Meaning                                                                                              |
| ----------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`        | string                    | `notification:<n>` for avvisi, `message:<n>` for messages. PoliTO's own id, so it's stable across calls. |
| `kind`      | `"avviso"` \| `"message"` | Course avviso or school message.                                                                     |
| `course`    | string \| null            | Course name for avvisi, `null` for messages.                                                         |
| `title`     | string                    | Title as PoliTO sent it.                                                                             |
| `text`      | string                    | Full text. For avvisi, the course notice; if it can't be found, the short push text.                 |
| `sentAt`    | string                    | ISO 8601 timestamp, UTC.                                                                             |
| `isRead`    | boolean                   | Read state on PoliTO, shared with the phone app.                                                     |
| `urgent`    | boolean                   | `true` for messages of type `emergency`.                                                             |
| `sourceUrl` | string \| null            | Always `null` for now: the API gives no web link for avvisi or messages.                             |

Only notifications about course notices become avvisi. Notifications about new files, lectures or tickets are left out. Notifications that announce a school message are left out too, because the message itself is in the list.

### `GET /deadlines`

Optional `from` and `to` query parameters, as `YYYY-MM-DD`. The default is today to 30 days from today, in Italian time.

```json
{
  "deadlines": [
    {
      "id": "deadline:55",
      "title": "Termine per l'iscrizione e pagamento della prima rata",
      "date": "2026-10-20",
      "course": null,
      "type": "Iscrizioni e pagamento tasse",
      "url": "https://www.polito.it/tasse"
    }
  ]
}
```

PoliTO's deadlines are administrative (fees, enrolment, graduation sessions), so `course` is always `null`. `type` is PoliTO's category. Most deadlines come without an id; for those, `id` is a hash of date and title, stable as long as PoliTO doesn't edit them.

### `POST /items/{id}/read`

Marks one item read on PoliTO. URL-encode the id (`notification%3A901`); a plain colon works too. Marking a message read also marks the push notification that announced it. If that second step fails, the request still succeeds, because the message itself is already read, and `/health` shows the error.

- `400` when the id isn't `notification:<n>` or `message:<n>`.
- `404` when PoliTO doesn't know the id.

### `GET /health`

```json
{ "ok": true, "loggedIn": true, "lastError": null }
```

`loggedIn` says whether a token is stored. `lastError` is the message from the last failed PoliTO call, and goes back to `null` after the next successful one; `ok` is `false` while it's set. `lastError` can be set even when `/items` returned 200: if one course's notice list fails, those avvisi fall back to their short push text. This endpoint makes no PoliTO calls.

### Errors

| Status | When                                                                        |
| ------ | --------------------------------------------------------------------------- |
| `400`  | Bad item id or date.                                                        |
| `401`  | Missing or wrong bearer token.                                              |
| `404`  | Unknown path, or PoliTO answered 404.                                       |
| `502`  | PoliTO failed: network error, 5xx, or rejected login. `error` says which.   |

## Does logging in sign out the phone app?

Not verified yet: it needs your real account. What the code does to avoid it:

- It logs in with its own client id (kept in `data/session.json`) and device name `areadidattica`, so PoliTO sees a second device, not a replacement for the phone.
- It sends no push token, so push notifications keep going to the phone only.
- It logs in once and keeps the token, so even if PoliTO allowed one session per account, the phone would be signed out at most once, not on every check.

To find out:

1. Open the PoliTO app on your phone and check you're signed in.
2. On devbox, run `npm run live-check -- --fresh-login`.
3. Back on the phone, pull to refresh the notifications. If the app asks you to sign in again, logging in here signs the phone out.

## Live check

`npm run live-check` calls the real PoliTO API with the credentials in `.env` and the session in `data/`. It prints counts, the notification scopes it saw, and the five newest items. It never prints the password or the token.

```bash
npm ci
npm run live-check                                  # reuses the stored token
npm run live-check -- --fresh-login                 # forces a new login
npm run live-check -- --save fixtures-live          # also saves the raw responses
```

The saved responses contain your personal data. `fixtures-live/` is gitignored; strip names and ids before copying anything into `test/fixtures/`.

## Configuration

Set these in `.env`. [`.env.example`](.env.example) has the template.

| Variable                | Required | Default                                | What it does                                       |
| ----------------------- | -------- | -------------------------------------- | -------------------------------------------------- |
| `POLITO_USERNAME`       | yes      |                                        | Your student id, like `s123456`.                   |
| `POLITO_PASSWORD`       | yes      |                                        | Your PoliTO password.                              |
| `API_TOKEN`             | yes      |                                        | Bearer secret for this API, 24 characters or more. |
| `NOTICES_CACHE_SECONDS` | no       | `300`                                  | How long course notice lists stay cached.          |
| `UPSTREAM_GAP_MS`       | no       | `250`                                  | Minimum pause between two PoliTO calls.            |
| `POLITO_APP_VERSION`    | no       | `1.6.2`                                | App version sent at login.                         |
| `POLITO_BUILD_NUMBER`   | no       | `1060200`                              | App build number sent at login.                    |
| `POLITO_BASE_URL`       | no       | `https://app.didattica.polito.it/api`  | API base. The public mock is at `/mock/api`.       |
| `HOST`, `PORT`          | no       | `127.0.0.1`, `8788`                    | Where the server listens. Compose sets these.      |
| `DATA_DIR`              | no       | `./data`                               | Where `session.json` lives. Compose uses `/data`.  |

The server logs one line per request (method, path, status, time) and nothing else about you.

## Development

```bash
npm ci
npm test            # 38 tests against a fake PoliTO server, no network
npm run typecheck
```

The tests serve the JSON in [`test/fixtures/`](test/fixtures/) from a local stand-in for the PoliTO API. The fixtures follow the [PoliTO OpenAPI spec](https://github.com/polito/api-spec/blob/master/dist/clients/student/openapi.yaml); refresh them from `npm run live-check -- --save` when the real responses differ. CI runs the same three commands plus `docker build`.

To try the whole container without your account, point it at PoliTO's public mock server, which accepts any login and answers with example data:

```bash
POLITO_BASE_URL=https://app.didattica.polito.it/mock/api
```

## License

No license yet: all rights reserved. The PoliTO API spec and the PoliTO apps belong to Politecnico di Torino.
