# Command line

`areadidattica` is a command that reads your PoliTO account and prints JSON: avvisi, messages, deadlines, course files, timetable, exams, grades, bookings and more. It logs in the way the PoliTO Students app does, keeps the token on disk and reuses it, so a run makes only the PoliTO calls it needs. It needs no server and no Docker.

This page is written so an AI agent, like a Grok Bot, can install the command and use it on its own computer.

## Install

You need Linux or macOS, `git`, and Node.js 24 or newer (`node --version`). Node runs the TypeScript directly, and the command has no dependencies to install.

1. Clone the repo and put the command on your `PATH`:

   ```bash
   git clone https://github.com/SuperTost100/areadidattica-cli.git ~/areadidattica
   mkdir -p ~/.local/bin
   ln -sf ~/areadidattica/bin/areadidattica ~/.local/bin/areadidattica
   ```

2. Give it the PoliTO login. Either set `POLITO_USERNAME` and `POLITO_PASSWORD` in the environment, or write them to `~/.config/areadidattica/env`, readable by you only:

   ```bash
   mkdir -p ~/.config/areadidattica
   touch ~/.config/areadidattica/env
   chmod 600 ~/.config/areadidattica/env
   ```

   Then put these two lines in that file, with the real values:

   ```text
   POLITO_USERNAME=s123456
   POLITO_PASSWORD=the-password
   ```

3. Check it:

   ```bash
   areadidattica login
   ```

   ```json
   {
     "loggedIn": true,
     "newLogin": true
   }
   ```

To update later, run `git -C ~/areadidattica pull`.

<details>
<summary>No Node.js 24? Install it without root</summary>

This downloads the latest Node.js 24 for Linux x64 into `~/.local/node`:

```bash
v=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o 'node-v24[^ ]*-linux-x64.tar.xz' | head -1)
mkdir -p ~/.local/node ~/.local/bin
curl -fsSL "https://nodejs.org/dist/latest-v24.x/$v" | tar -xJ -C ~/.local/node --strip-components=1
ln -sf ~/.local/node/bin/node ~/.local/bin/node
```

Check that `~/.local/bin` is on your `PATH` with `node --version`.

</details>

> [!IMPORTANT]
> Never print, log or send the password. If the login fails with HTTP 401, the password is wrong: ask the account owner, and don't retry. After a rejected login the command refuses to log in for 5 minutes, so a wrong password can't lock the account.

## How it answers

- **Output.** Results go to stdout as JSON. Most commands print a list.
- **Errors.** They go to stderr as `{"error": "<message>"}`. The exit code is `1` when PoliTO failed and `2` when the command was wrong (bad arguments, unknown course, a write without `--allow-writes`).
- **Courses.** A `<course>` argument takes the course id, the shortcode (`01NYHOV`) or part of the name (`fisica`), without regard to case or accents. When the name matches several courses, the error lists them with their ids.
- **Help.** `areadidattica help` lists every command.

## Avvisi, messages and deadlines

| Command | What it prints |
| --- | --- |
| `items [--unread]` | Course avvisi and school messages, newest first, with the full text |
| `read <item-id>` | Marks an avviso or message read on PoliTO, also in the phone app |
| `notices <course>` | Every avviso a course still shows, as plain text |
| `deadlines [--from D] [--to D]` | Administrative deadlines, by default from today to 30 days ahead |

`items` gives each entry an `id` like `notification:901` or `message:7001`, which `read` takes. The [API reference](api.md#get-items) describes every field.

```bash
areadidattica items --unread
```

```json
[
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
```

## Course files

| Command | What it does |
| --- | --- |
| `files [<course>] [--since D] [--search TEXT]` | Lists the course material. Without a course, every course |
| `download <course> <id>... [--out DIR] [--max-mb N] [--force]` | Saves files, or every file in a folder |

`files` flattens the folder tree into one list. `folder` is the path from the course root, and `--since 2026-10-20` keeps files uploaded on or after that day, so it answers "what's new this week". `--search` matches the folder and file name.

```bash
areadidattica files fisica
```

```json
[
  {
    "courseId": "309950",
    "course": "Fisica I",
    "id": "34204201",
    "name": "Turni Quiz 16 ottobre 2026.pdf",
    "folder": "Esami",
    "sizeKB": 24,
    "mimeType": "application/pdf",
    "createdAt": "2026-10-16T10:57:52+02:00",
    "checksum": "9c1185a5c5e9fc54612808977ee8f548b2258d31"
  }
]
```

`download` takes file ids and folder ids from that list. It saves each file as `<DIR>/<course> (<id>)/<folder>/<name>`, where `DIR` is `~/Downloads/polito` unless `--out` or `AREADIDATTICA_DOWNLOADS` says otherwise, and prints the paths:

```bash
areadidattica download fisica 34204201
```

```json
{
  "downloaded": [
    { "id": "34204201", "path": "/home/you/Downloads/polito/Fisica I (309950)/Esami/Turni Quiz 16 ottobre 2026.pdf", "bytes": 24738 }
  ],
  "skipped": [],
  "failed": []
}
```

- **Unchanged files are skipped.** A file whose checksum matches the last download to the same path isn't fetched again. `--force` downloads it anyway.
- **Size limit.** One run downloads at most 200 MB in total. A file that doesn't fit is skipped with the reason, before any byte is fetched. Raise the limit with `--max-mb`, for a videolecture for example.
- **Safe paths.** Slashes and `..` in PoliTO's names become `_`, so a file always lands inside its course folder. Two files that would get the same name get their id added, like `Slides (34100008).pdf`.

## Courses and timetable

| Command | What it prints |
| --- | --- |
| `courses` | Your courses with id, shortcode, credits, teacher and period |
| `course <course>` | One course in detail |
| `guide <course>` | The course guide: program, exam rules, books |
| `lectures [--from D] [--to D] [--course C]` | The timetable. PoliTO's default is 7 days before and after today |
| `next-lecture <course>` | The next lecture of a course |
| `videolectures <course>` | Recorded lectures, with video and audio links |
| `virtual-classrooms <course> [--live]` | Virtual classroom recordings, or the ones live now |
| `assignments <course>` | Assignments (elaborati) you uploaded |

## Exams, grades and career

| Command | What it prints |
| --- | --- |
| `exams` | Exam sessions (appelli), with `status` saying whether you can book |
| `grades` | Grades on your record |
| `provisional-grades` | Grades waiting for you to accept or reject |
| `career` | Degree, enrolment and credits |
| `profile` | Your PoliTO profile |

## Bookings, campus and the rest

| Command | What it prints |
| --- | --- |
| `bookings` | Your bookings |
| `booking-topics` | What you can book |
| `booking-slots <topic-id> [--from D] [--to D]` | Free slots for a topic |
| `booking-seats <topic-id> <slot-id>` | Seats in a slot |
| `people <search>`, `person <id>` | Teachers and staff, with office and courses |
| `sites`, `buildings <site-id>` | Campus sites (like `TO_CENCIT`) and their buildings |
| `places [--search TEXT] [--site ID]`, `place <id>` | Rooms, labs and offices |
| `free-rooms <site-id> --date D --from HH:MM --to HH:MM` | Rooms free in a time range |
| `news [<id>]`, `job-offers [<id>]` | PoliTO news and job offers |
| `tickets [<id>]` | Your support tickets |
| `surveys`, `unread-emails`, `announcements`, `events`, `offering`, `guides` | The other lists the PoliTO app shows |
| `api GET <path>` | Any other path of the [PoliTO API](https://github.com/polito/api-spec), raw |

These print PoliTO's own `data` field as it comes. Their fields are in the [PoliTO OpenAPI spec](https://github.com/polito/api-spec/blob/master/dist/clients/student/openapi.yaml).

## Commands that change the account

These run only with `--allow-writes`. Without it they stop with exit code `2` and call nothing on PoliTO.

| Command | What it does |
| --- | --- |
| `exam-book <exam-id> [--reason TEXT] [--question-id N --question-option N]` | Books an exam session from `exams` |
| `exam-cancel <exam-id>` | Cancels an exam booking |
| `grade-accept <id>` | Accepts a provisional grade. It goes on the record and **can't be undone** |
| `grade-reject <id>` | Rejects a provisional grade, so the exam has to be taken again |
| `booking-create <slot-id> [--seat N]` | Books a slot, with a seat when the slot asks for one |
| `booking-cancel <booking-id>` | Cancels a booking |
| `api <METHOD> <path> [--body JSON]` | Any call that isn't `GET` |

```bash
areadidattica exam-book 887981 --allow-writes
```

> [!CAUTION]
> An agent should use `--allow-writes` only when the account owner asked for that exact action in this conversation, and should confirm the exam, grade or slot with them first. Marking avvisi and messages read with `read` needs no flag.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `POLITO_USERNAME`, `POLITO_PASSWORD` |  | The PoliTO login. Required |
| `AREADIDATTICA_ENV_FILE` | `~/.config/areadidattica/env` | A file with these variables, one `NAME=value` per line. The environment wins over it |
| `DATA_DIR` | `~/.local/state/areadidattica` | Holds `session.json` (the token) and `downloads.json` (checksums of downloaded files), both readable by you only |
| `AREADIDATTICA_DOWNLOADS` | `~/Downloads/polito` | Where `download` saves files |
| `UPSTREAM_GAP_MS` | `250` | Minimum pause between two PoliTO calls |
| `POLITO_BASE_URL` | `https://app.didattica.polito.it/api` | The API base |

The command sends nothing anywhere except to PoliTO, and only for the command you run.
