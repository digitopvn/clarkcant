During #302 final verification, the PDF attachment journey sent its message before the upload completed. The trace records upload starting at 14:21:04.293Z and taking 363ms; the message starts at 14:21:04.394Z and its JSON contains only text, no attachmentIds. The fixture correctly has no attached PDF to read and reports missing capability. This is a real user-visible race, not a PDF extractor failure.

Cause: the composer exposes send while chips are checking/uploading, and useTurnSend selects only already-ready attachment IDs then clears pending chips on success. Pressing Enter during upload can silently send text without the selected file.

Related #17 (closed attachment implementation), #302/PR368 verification context; no open duplicate found. Keep the repair as a focused commit alongside #302, without delaying a verified #300 head by mixing unrelated changes into it.

Acceptance:
- Delay the real attachment request deterministically; pressing Enter while pending must not start a message or clear draft/chips. The visible Send control reflects readiness.
- After upload completes, Send/Enter sends the actual stored attachment once and the production pipeline reads its content.
- Failed chips retain their explanation and existing send behavior; independent surface messages do not consume draft attachments; Stop and typed commands during a running turn remain usable.
- Focused real-browser regression and the PDF journey pass; fresh full verification and all exact-head cross-platform CI pass without hiding failures.
- Paired official documentation explains that sending waits for selected uploads to finish, without claiming auto-send or fake progress.
