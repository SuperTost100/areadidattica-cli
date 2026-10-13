# API reference

areadidattica answers on `http://127.0.0.1:8789` by default. All four endpoints are below, with the fields they return and the errors they give.

## Authentication

Every endpoint needs `Authorization: Bearer <API_TOKEN>`; without it the answer is `401 {"error":"unauthorized"}`. Responses are JSON in UTF-8. Errors look like `{"error": "<message>"}`.

| Method | Path               | Returns                                |
| ------ | ------------------ | -------------------------------------- |
| `GET`  | `/items`           | `{ "items": Item[] }`, newest first    |
| `GET`  | `/deadlines`       | `{ "deadlines": Deadline[] }`, by date |
| `POST` | `/items/{id}/read` | `{ "ok": true, "id": "<id>" }`         |
| `GET`  | `/health`          | `{ "ok", "loggedIn", "lastError" }`    |

## `GET /items`

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

| Field       | Type                      | Meaning                                                                                                                                        |
| ----------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | string                    | `notification:<n>` for avvisi, `message:<n>` for messages. PoliTO's own id, so it's stable across calls.                                       |
| `kind`      | `"avviso"` \| `"message"` | Course avviso or school message.                                                                                                               |
| `course`    | string \| null            | Course name for avvisi, `null` for messages.                                                                                                   |
| `title`     | string                    | Title as PoliTO sent it.                                                                                                                       |
| `text`      | string                    | Full text. For avvisi, the course notice; if it can't be found, the short push text. Tables come as one line per row, cells separated by tabs. |
| `sentAt`    | string                    | ISO 8601 timestamp, UTC.                                                                                                                       |
| `isRead`    | boolean                   | Read state on PoliTO, shared with the phone app.                                                                                               |
| `urgent`    | boolean                   | `true` for messages of type `emergency`.                                                                                                       |
| `sourceUrl` | string \| null            | Always `null` for now: the API gives no web link for avvisi or messages.                                                                       |

Only notifications about course notices become avvisi. Notifications about new files, lectures or tickets are left out. Notifications that announce a school message are left out too, because the message itself is in the list.

## `GET /deadlines`

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

## `POST /items/{id}/read`

Marks one item read on PoliTO. URL-encode the id (`notification%3A901`); a plain colon works too. Marking a message read also marks the push notification that announced it. If that second step fails, the request still succeeds, because the message itself is already read, and `/health` shows the error.

- `400` when the id isn't `notification:<n>` or `message:<n>`.
- `404` when PoliTO doesn't know the id.

## `GET /health`

```json
{ "ok": true, "loggedIn": true, "lastError": null }
```

`loggedIn` says whether a token is stored. `lastError` is the message from the last failed PoliTO call, and goes back to `null` after the next successful one; `ok` is `false` while it's set. `lastError` can be set even when `/items` returned 200: if one course's notice list fails, those avvisi fall back to their short push text. This endpoint makes no PoliTO calls.

### Errors

| Status | When                                                                      |
| ------ | ------------------------------------------------------------------------- |
| `400`  | Bad item id or date.                                                      |
| `401`  | Missing or wrong bearer token.                                            |
| `404`  | Unknown path, or PoliTO answered 404.                                     |
| `502`  | PoliTO failed: network error, 5xx, or rejected login. `error` says which. |
