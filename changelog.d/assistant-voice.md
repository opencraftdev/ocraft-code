### Added
- Assistant voice mode, server side: the Assistant VM keeps an ElevenLabs agent ("Nara") in step
  with the profile's new `VOICE.md`, hands out a short-lived conversation token, and answers the
  persona's tools (`ask_assistant`, `sessions`, `last_result`) under `/api/assistant/voice/`, also
  through another Ovis's PC proxy. Risky asks (merge, push, delete, close a session, send a
  message) are sent only once confirmed, and each voice request is one line in the day's log. The
  ElevenLabs key stays in the VM's `voice.json` and is never in an answer or a log.
- Assistant voice mode in the browser: a Chat | Voice switch in the Assistant pane's header only
  (Chat unchanged), a call screen with Nara (orb, captions, task cards, mute, end), end on 10 s of
  silence, a chime and a spoken summary when the Assistant finishes a voice request, an "on call"
  mark in the sidebar. See the guide's Assistant section for the ElevenLabs key.
