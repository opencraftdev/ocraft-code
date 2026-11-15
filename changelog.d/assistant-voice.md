### Added
- Assistant voice mode, server side: the Assistant VM keeps an ElevenLabs agent ("Nara") in step
  with the profile's new `VOICE.md`, hands out a short-lived conversation token, and answers the
  persona's tools (`ask_assistant`, `sessions`, `last_result`) under `/api/assistant/voice/`, also
  through another Ovis's PC proxy. Risky asks (merge, push, delete, close a session, send a
  message) are sent only once confirmed, and each voice request is one line in the day's log. The
  ElevenLabs key stays in the VM's `voice.json` and is never in an answer or a log.
