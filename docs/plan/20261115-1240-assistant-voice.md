# Assistant: voice conversation (speech to speech, with a persona)

Status: done
Created: 2026-11-15 12:40
Follows: [Assistant graph and profile](20261112-1900-assistant-graph-and-profile.md),
[Assistant delegation](20261112-1622-assistant-delegation.md)

## Goal

Talk to the Assistant like to a person, in Indonesian, English or both mixed. A voice persona with
its own personality answers within a second, hands real work to the Assistant (Claude on the VM),
and tells you the outcome as a short spoken summary, never a read-out of the reply.

## Scope

- In: a Chat | Voice switcher in the **Assistant pane only** (Chat unchanged); ElevenLabs Agents as the voice; the persona
  file; a token route and the persona's tools on the **Assistant VM's** Ovis; the Mac's machine proxy
  passing those routes through; a spoken summary when the Assistant finishes a voice request.
- Out: voice in any other pane (their dictation mic stays as it is); a wake word ("Hey ..."); phone
  calls; voice on the MacBook Pro or in its herdr sessions; a second provider (the persona and its
  tools stay provider-neutral enough to swap later, but only ElevenLabs is built).

## How it works

```
 you (mic/speaker, any browser)
   │  WebRTC audio, straight to ElevenLabs (a short-lived token, never the key)
   ▼
 ElevenLabs agent "persona"  ── thinks with a small LLM, speaks with an ElevenLabs voice
   │  client tools, run in the page, answered by the VM through Ovis
   ▼
 Assistant VM Ovis (raka-devs) ── holds the key, the persona file, the tools
   ├─ ask_assistant(text)  → types into the Assistant's pane (Claude), as you would
   ├─ sessions(machine?)   → graph.json (what runs where), answered at once
   └─ last_result()        → the Assistant's latest finished reply
```

The Mac's Ovis only passes the token and tool calls to the VM; it holds no key and does no voice
work. Audio does not go through the VM: relaying it (browser → Mac → VM → ElevenLabs) would add
delay to every sentence and load a 2-CPU VM.

## Decisions (proposed, for your approval)

### 1. Provider and plan

| # | Decision |
|---|----------|
| 1.1 | **ElevenLabs Agents, Free plan first**: 15 minutes a month, 4 concurrent calls, multilingual. Creator ($22/month, 275 min, then $0.08/min) when the trial is not enough. |
| 1.2 | **You** create the ElevenLabs account and an API key; I put the key on the VM only, in `~/.config/ovis/assistant/voice.json` (0600). The Mac and the MacBook Pro never hold it. |
| 1.3 | **The VM creates and updates the ElevenLabs agent itself** through the ElevenLabs API (persona prompt, first message, voice, LLM, language, tools), so nothing is set up by hand in the ElevenLabs dashboard and the agent always matches the persona file. Its id is kept in `voice.json`. |
| 1.4 | **Persona LLM:** a small fast model ElevenLabs offers (Gemini Flash class); its cost is billed by ElevenLabs at the provider's rate. Claude stays the one that does the work. |

### 2. The persona

| # | Decision |
|---|----------|
| 2.1 | **File:** `agent/profiles/assistant/VOICE.md` next to SOUL.md: name, personality, how it speaks. Seeded once by the server; you (or the Assistant) can edit it; the VM pushes changes to the ElevenLabs agent at the next voice start. |
| 2.2 | **Default personality:** calm, warm, a little dry humour; speaks like a colleague, not a reader; 1–3 sentences per turn; numbers and names over lists; never reads code, paths or logs aloud ("I put the details on screen"). |
| 2.3 | **Language:** answers in the language you just spoke; a mixed Indonesian/English sentence gets a natural mixed answer. ElevenLabs' multilingual voice and its language-detection tool. |
| 2.4 | **Context at start:** the persona gets a short brief: your name and preferences from PROFILE.md (the first lines only), the machines and how many sessions run on each (from graph.json), and the Assistant's state (idle / working on X). Not the whole profile. |

### 3. UX (agreed 2026-11-15)

```
┌ Assistant ─────────────────────────────┐
│                                [ _ ]   │   [ _ ] minimizes to the bar
│               .-"""-.                  │
│              (   ◉   )   Nara          │   orb moves with your voice / hers
│               '-...-'                  │
│   "Oke, aku kasih ke Assistant ya."    │   live captions (you and Nara)
│  ┌──────────────────────────────────┐  │
│  │ → cek CI di ovis, merge kalau    │  │   one card per task sent to Claude
│  │   hijau             ● working…   │  │   (⏸ waiting for your OK / ● working / ✓ done)
│  └──────────────────────────────────┘  │
│   12/15 min      [ mute ]   [ end ]    │
└────────────────────────────────────────┘
after silence:  [◉ Assistant working… 1 task  ▴]   (thin bar over the composer)
when done:      chime → the full-screen call opens again and Nara says the summary
```

| # | Decision |
|---|----------|
| 3.0 | **Chat stays as it is.** A segmented switcher **Chat \| Voice** in the Assistant pane's header. Chat = today's chat, composer, `@` tags, Sessions panel, unchanged and the default. Voice = Nara's call screen in the same pane. The choice is remembered per device. Switching to Chat during a call keeps the call going as audio with a thin "On call with Nara" bar above the composer (tap = back to Voice); everything sent to Claude is in the chat as `[voice]` messages. You can type in Chat while a call is open. |
| 3.1 | **Persona name: Nara.** Greets short ("Ya, ada apa?") when a call opens. |
| 3.2 | **Start:** choosing Voice opens the **full-screen call** in the Assistant pane (the call starts on the orb tap, not on the switch, so switching alone never spends minutes): a big orb (listening / thinking / speaking), live captions of both sides, trial minutes left, mute, end, minimize. Talking over Nara stops her at once. |
| 3.3 | **Quick questions** ("what's running on the macbook-pro?", "is PR 34 merged?") Nara answers herself from `sessions()` / `last_result()`. |
| 3.4 | **Work** goes to Claude through `ask_assistant` and shows as a **task card** in the call (the exact text sent, then working → done). The text lands in the Assistant's chat as a normal message marked `[voice]`. |
| 3.5 | **Read back only risky asks:** anything that changes things outside (merge, push, delete, close a session, send a message to someone) Nara repeats in one sentence and waits for "ya"/"yes"; its card shows "waiting for your OK". Other asks go straight through. Enforced in the `ask_assistant` tool (a `confirmed` flag the persona must set for risky asks), not only in the prompt. |
| 3.6 | **Saving minutes:** after **10 s of silence** with nothing waiting for your OK the call ends and the screen shrinks to a thin bar "Assistant working… N tasks". Nothing is held open while Claude works. |
| 3.7 | **Result:** when Claude comes to rest after a `[voice]` message: a chime, the full-screen call opens again and Nara gives a 1–3 sentence summary, then listens 10 s for a follow-up. |
| 3.8 | **Outside the Assistant pane:** an open call keeps going as audio only, with an "on call" dot on the Assistant in the sidebar. A result that arrives while you are elsewhere plays the chime and a toast "Assistant done — tap to hear"; tapping it goes to the Assistant and opens the call. Nara never speaks by herself outside the Assistant. If the page is closed, the Assistant shows "Answered — tap to hear" next time. |
| 3.9 | **Trouble** (no key, trial minutes used up, mic refused, VM offline): the call screen shows one line saying what and a button to fix it (open the guide, open mic settings, retry). |
| 3.10 | Only `ask_assistant` text reaches Claude; Nara's own talk does not. |

### 4. Server (VM) and proxy

| # | Decision |
|---|----------|
| 4.1 | **Routes on the VM's Ovis** (Assistant VM only, refused elsewhere): `POST /api/assistant/voice/session` (syncs the agent if VOICE.md changed, returns a WebRTC conversation token + the brief; never the key), `POST /api/assistant/voice/tool` (`ask_assistant`, `sessions`, `last_result`), `GET /api/assistant/voice/status` (configured, minutes used this month from the ElevenLabs API). |
| 4.2 | **Mac proxy:** `MACHINE_PROXY_PATH` (`server/machine-api.ts`) gains `assistant/voice/(session|tool|status)`; a watch-only device gets `read_only` like other writes. |
| 4.3 | **`ask_assistant`** uses the same send path the composer uses for the Assistant pane (so drafts, queued input and the "nothing sent after a disconnect" rule still hold). |
| 4.4 | **Logs:** each voice request is one line in the profile's daily log (`logs/YYYY-MM-DD.md`): time, what was asked, voice. The audio is not stored by Ovis. |

### 5. Client

| # | Decision |
|---|----------|
| 5.1 | `@elevenlabs/client` (`Conversation.startSession({ conversationToken, connectionType: "webrtc", clientTools })`), loaded lazily on the first tap so the app's start size does not grow. |
| 5.2 | The Chat \| Voice switcher shows only in the Assistant pane's header; no other pane gets it. Without a key on the VM, Voice shows "Voice needs an ElevenLabs key" and links to the guide; Chat works as before. |
| 5.3 | Microphone needs HTTPS: the tailnet `https://…ts.net` address has it; Ovis.app may ask for microphone permission once. Headphones recommended (the browser's echo cancellation is on). |

## Privacy

What leaves the VM/browser for ElevenLabs (and the persona's LLM through it): your voice, the brief
(your name/preferences, machine names, session counts), what you ask, and the Assistant's replies it
summarizes. That can include Potenlab work (Trina, Dion, Depras). The profile, the graph file and
your herdr sessions themselves stay on your machines. ElevenLabs' retention settings for the Free
plan are to be checked before the first real call (see open questions).

## Touches

- `server/assistant-voice.ts` (new: config, agent sync, token, tools, status), `server/assistant.ts`
  (routes), `server/assistant-sessions.ts` (VOICE.md seed, `[voice]` marker, log line),
  `server/machine-api.ts` (proxy paths), `shared/assistant.ts` (types).
- `src/components/AssistantVoice.tsx` + CSS (button, rings, transcript), `src/components/Composer.tsx`
  (mount it in the Assistant pane only), `src/lib/assistantVoice.ts` (session, tools, chime), i18n.
- `package.json` / `bun.lock`: `@elevenlabs/client`.
- Docs: `docs/guide.md` Assistant section (voice, the key, the costs).

## Steps

1. Server: voice.json, VOICE.md seed, agent sync, token/tool/status routes, proxy paths; tests with a
   fake ElevenLabs API (the key never appears in a response or a log).
2. Client: button (Assistant pane only), lazy SDK, client tools, transcript, end-on-silence, the
   result call and chime; tests with a fake SDK.
3. Demo QA script and screenshots (idle, listening, speaking with transcript, "needs a key"; dark
   and light) on the demo build, no real ElevenLabs call.
4. Changelog fragment, guide, plan status. PR, merge on your word, deploy to the Mac and the VM.
5. You add the ElevenLabs key (or give it to me to place on the VM); one real call of about
   2 minutes (Indonesian, English, mixed, one `ask_assistant`) to check voice, language and the
   result call. That spends about 2–4 of the 15 trial minutes.

## Checks

- Unit: token route never returns or logs the key; agent sync only when VOICE.md changed; tools
  (ask_assistant sends one message with `[voice]`, sessions reads graph.json, last_result); routes
  refused on a non-Assistant server; proxy passes only the three paths; read-only device refused.
- Browser (demo, fake SDK): the button only in the Assistant pane; states; transcript; silence ends
  the call; the result call after the Assistant comes to rest.
- `bun run check fast`; `check:assistant` after deploy (gains: voice status answers).

## Open questions

- Name: Resolved (2026-11-15): **Nara**. Layout: Resolved: full-screen call with task cards.
  Elsewhere: Resolved: chime + toast. Switcher: Resolved: Chat | Voice in the Assistant header. Confirm: Resolved: read back risky asks only. Silence: Resolved: 10 s.
- Nara's **voice**: I shortlist three ElevenLabs voices that speak Indonesian well; you pick by ear
  (after the key is in, costs no agent minutes).
- Privacy: check whether the ElevenLabs Free plan keeps or trains on conversations, and turn
  conversation storage off in the agent if the plan allows it. OK to proceed if it cannot be turned
  off on Free?

## As built

- Server: `server/assistant-voice.ts`. The three client tools are created with `POST /v1/convai/tools`
  and attached by `tool_ids` (the agent body's inline `prompt.tools` is deprecated); the agent uses
  `gemini-2.5-flash`, `eleven_flash_v2_5`, first message "Ya, ada apa?" (an English preset "Yes,
  what's up?") and the `language_detection` system tool. voice.json also keeps `tool_ids`,
  `tools_hash` and, while tools are being made, `tools_partial`. An agent ElevenLabs no longer has
  (404) is made again. `ask_assistant` sends through the session's own send path (herdr
  `agent.prompt`), refuses a pane waiting on a prompt, and gates risky asks by a keyword check
  (English and Indonesian); the persona sets `confirmed`, so the gate is a backstop, not a guard
  against a persona that was talked into it.
- Minutes: ElevenLabs' API reports characters, not agent minutes, so `status.minutes` is null and
  the call screen shows no minutes line. The ElevenLabs dashboard shows them.
- `status.assistant.pending` lists working tasks and the newest finished ones with their replies.
  Several tasks pending at once all finish with the same latest reply.
- Client: the switch's buttons read Chat / Voice, named "Assistant chat" / "Assistant voice" for
  screen readers (the header already has a "Chat" button). Switching to Chat is the minimize. A
  read-back holds an open call for at most 45 s. The chime is the alert sound's. A small toast of its
  own (the app had none). The "on call" mark in the sidebar is the Voice glyph in the accent colour.
- A result that finished while no page was open: the next page load offers the newest one once, with
  the same "tap to hear" note (no chime); told or dismissed ids are kept per device.

