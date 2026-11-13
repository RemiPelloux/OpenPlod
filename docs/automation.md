# Automation: Webhooks, Rules, and Reviewed Tasks

OpenPlod can tell other systems when something happens (webhooks), act on new recordings with rules you write (rules), and turn action items into tasks you approve before they reach Todoist, Linear, or Notion (reviewed tasks). Everything is off until you set it up, and nothing leaves your computer for a destination you have not approved.

Open **Automations** in the desktop app. It has tabs for **Rules**, **Webhooks**, **Tasks**, and **History**. Every action is also available through the API under `/api/v1/webhooks` and `/api/v1/automations`; the exact contract is in the [API reference](api.md#webhooks).

## Safety Model

These rules hold for every automation feature:

| Rule | How it is enforced |
| --- | --- |
| Transcript text never triggers or changes an action | Rules are data you wrote. Filters look at recording metadata (source, type, tags, duration), never at transcript text. Task drafts are created from action items, but exporting them takes a separate, explicit confirmation |
| You approve every destination | A webhook to an address outside this computer needs `acknowledgeExternal`. Including transcript or document text in webhook payloads needs a separate `acknowledgeText`. A rule cannot be enabled until every provider or host it would send data to is acknowledged on the rule itself |
| Approval is re-checked when work runs | Each rule step re-checks its acknowledgement and local-only mode at the moment it runs. If you change AI settings later so a rule would use a different provider, that step fails with an explanation instead of sending |
| Local-only mode wins | In local-only mode, webhooks to non-loopback addresses are recorded as `blocked`, rule steps that need a cloud provider fail, and task exports are refused. Nothing is sent |
| Retries never duplicate work | Webhook events, deliveries, rule runs, rule steps, and task exports all have stable ids. Retrying, restarting, or receiving the same event twice reuses them, so no second job, document, tag, event, or remote task is created |
| Uncertain is not success | A timeout or dropped connection after a request may have been sent is recorded as `unknown`, not as delivered. Unknown outcomes are not retried automatically; you decide |
| Nothing is posted on a schedule | Webhooks fire on events. Rules fire on new imports. Task exports only happen when you press Export |

What automation does **not** promise: it does not estimate rule costs (the preview says the cost is unknown; see [spending limits](ai-providers.md#spending-limits-and-prices) for transcription estimates), and the Todoist, Linear, and Notion adapters have been tested against recorded request shapes only, not against the live services.

## Webhooks

A webhook subscription sends a signed HTTP `POST` to your URL whenever one of its chosen events happens.

| Event | Sent when | Contains |
| --- | --- | --- |
| `recording.imported` | A recording is added from any source | Recording id, type, duration, recorded time, source, and original filename |
| `recording.transcribed` | A transcription is saved | Recording and transcript version ids, provider, model, whether it became current |
| `document.created` | A note is created | Document id, title, folder, revision, source recording and version |
| `job.failed` | A processing job fails (not when cancelled) | Job id and type, recording id, error message |

Payloads carry ids and metadata, not transcript text. Filenames and note titles are metadata and are included. With **Include text** (and its separate confirmation), `recording.transcribed` and `document.created` also carry the transcript or note text.

### Set one up

1. In **Webhooks**, enter a name, the URL, and the events you want. The URL must be HTTPS, or plain HTTP to `localhost`, `127.0.0.1`, or `[::1]`. It cannot contain a username, password, or `#fragment`.
2. Confirm sending to an outside address, and separately confirm text if you turned on **Include text**.
3. Copy the signing secret (`whsec_…`). It is shown once. If you lose it, rotate it to get a new one.
4. Press **Send test** to deliver a signed `webhook.test` event and see the result in **Deliveries**.

Automation tools such as n8n, or your own service, can receive these events. A SaaS product that expects its own payload format needs a receiver that maps OpenPlod's payload to it.

### Verify the signature

Each request has `OpenPlod-Signature: t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 of `"<t>.<raw body>"` with your secret. Verify it against the raw bytes before parsing, reject old timestamps, and deduplicate on `OpenPlod-Event-Id`, because retries and redeliveries reuse it. A complete JavaScript example is in the [API reference](api.md#webhooks).

### Delivery, retries, and redelivery

- Each attempt waits up to 10 seconds and refuses redirects. A 2xx answer means **delivered**.
- A non-2xx answer, or a connection that provably never opened, is retried automatically with growing delays (30 seconds, doubling, at most 1 hour) for up to 6 attempts, then marked **failed**.
- A timeout or connection reset is **unknown**: your endpoint may have processed it. It is not retried automatically. If your receiver deduplicates on the event id, **Redeliver** is safe.
- After 5 deliveries in a row fail, the subscription is disabled and shows why. Fix the endpoint and enable it again.
- **Redeliver** sends the same event again with the same event and delivery ids.
- Delivery history keeps every attempt (automatic or manual, status code, duration, error) but never the endpoint's response body. Finished deliveries older than 90 days are pruned with their attempts; pending deliveries are never pruned, and the event id is kept so a pruned event is still not sent twice.

## Rules

A rule reacts to a newly imported recording that matches its filters and runs up to eight steps in order. Example: "Plaud meetings longer than 5 minutes: transcribe with Mistral, draft meeting minutes into Documents/Meetings, tag them `auto`, and notify my n8n webhook."

### Filters

All filters are optional; empty filters match every new recording.

- **Source:** Plaud recorder, uploaded file, or a recording sent from the phone.
- **Recording type:** class, meeting, conversation, other.
- **Tag** already on the recording.
- **Minimum duration.** A recording whose duration is not known at import never matches a minimum. Some import paths only learn the duration after transcription, so those recordings do not match.

Rules run only for recordings imported **after** the rule is enabled. They never run on your existing library.

### Steps

| Step | What it does | Sends data to |
| --- | --- | --- |
| Transcribe | Queues a transcription with a chosen provider and/or profile, then waits for it | The speech provider (audio), unless it is Whisper.cpp |
| Generate document | Drafts a note from the transcript with a template, into a folder | The documents provider (transcript text), unless it is Ollama |
| Add tags | Adds tags to the recording | Nowhere |
| Add to collection | Adds the recording to a recording collection | Nowhere |
| Notify webhook | Sends one `automation.notify` event, with the results of the earlier steps, to one webhook | That webhook's host, unless it is on this computer |

A rule's transcription uses exactly the acknowledged provider: provider fallback is turned off for rules. If a transcription is already queued for that recording, the step joins it instead of starting a second one, and says so.

### Preview and approve

Before turning a rule on, press **Preview scope and data use**. The preview shows:

- which existing recordings the filters would match (up to 25, from the latest 2,000), to check the filters. They are not processed;
- every provider and host that would receive audio, text, or event metadata with today's settings, and which ones still need your acknowledgement;
- what local-only mode would block;
- that the cost is unknown. The preview does not price a rule.

Acknowledgements are stored on the rule as `audio:<provider>`, `text:<provider>`, or `webhook:<host>`. A rule cannot be enabled while any is missing.

### Costs

A rule cannot confirm a cost. If you set a monthly budget or a per-job threshold in AI settings and a rule's transcription needs cost confirmation, that transcription fails before sending anything, and the run shows the reason. Start it yourself from the recording to confirm the estimate.

### History, retry, and the kill switch

**History** lists every run with each step's status (`pending`, `waiting`, `done`, `skipped`, `failed`, `unknown`) and a short detail. A run is created once per rule and recording, so the same recording never runs a rule twice.

- **Retry failed steps** reruns only the failed, unknown, and skipped steps of a failed or cancelled run. Completed steps are never repeated. A retried document generation uses a new request, because the earlier one may have been billed.
- An interrupted document generation shows as `unknown`: the provider may have processed it.
- **Turning a rule off or deleting it** stops its in-flight runs at their next step; their remaining steps are `skipped`. History is kept.

## Reviewed Tasks

Action items found in a recording (from its saved analysis or from a structure extraction you just reviewed) become local **draft** tasks. You edit each one, approve it, and then export the approved ones to one connector.

1. **Create drafts.** Choose a recording and extract its action items, or add a task by hand. Extracting again never duplicates a draft. Only an exact `YYYY-MM-DD` date becomes the due date; a spoken date such as "next Friday" is kept as text for you to resolve.
2. **Review.** Edit the title, notes, owner, and due date, then **Approve**. Editing an approved task sends it back to draft.
3. **Export.** Choose Todoist, Linear, or Notion and press **Export approved tasks**. Only approved tasks are sent.
4. **Calendar.** Download a calendar file (`.ics`) with one all-day event per dated task. It is generated on this computer; nothing is sent.

Export outcomes per task:

| Outcome | Meaning |
| --- | --- |
| created | The service returned the new task's id (and link, when given) |
| failed | The service refused the request, or no connection was made. Exporting again retries it |
| unknown | No answer, a server error, or a success without an id: the task may exist. It is not resent unless you ask to resend unknown exports, which can create a duplicate. Check the service first |
| skipped | The task is not approved |

A task is created at most once per connector. A task that was (or may have been) exported cannot be deleted, only dismissed, so its export record is kept.

**Connector credentials** (Todoist API token; Linear API key and team id; Notion integration key, database id, and title and optional date property names) are entered under **Connector credentials** and are never shown again. In this build they are stored in the vault database without the encryption used for AI provider keys, and unencrypted backups keep them; protect the data directory and remove a token you no longer use by saving it empty. Exports are refused in local-only mode.

## Related

- [API reference: Webhooks, Automation Rules, Reviewed Tasks](api.md#webhooks)
- [AI providers: spending limits, fallbacks, local-only mode](ai-providers.md)
- [Provider privacy and cost](provider-privacy-and-cost.md)
