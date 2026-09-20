---
title: "Phase 1 — Typed preference registry & Settings API (~8h)"
status: done
---

# Phase 1 — Typed preference registry & Settings API (~8h)

### Mục tiêu

Biến generic preference store hiện có thành một registry typed duy nhất cho UI/runtime. Không cho component/gateway viết arbitrary preference keys.

### Files

- new: `packages/contracts/src/preferences.ts`
- update: `packages/contracts/src/index.ts`
- new hoặc update: `packages/core/src/preference-registry.ts`
- update: `packages/core/src/preferences.ts`
- update: `apps/runtime/src/gateway.ts`
- update: `packages/conversation-client/src/api.ts`
- tests: contracts/core/runtime

### Registry keys

| Key | Scope | Shape |
| --- | --- | --- |
| `experience.theme` | global | system/light/dark |
| `experience.motion` | global | system/full/reduced |
| `experience.density` | global | comfortable/compact |
| `orb.profile` | global | preset id |
| `orb.custom` | global | bounded palette/effect/physics |
| `execution.mode` | global | autonomous/guarded/ask |
| `execution.rules` | global | bounded rules |
| `ai.modelFavorites` | global | provider/model refs |
| `ai.backgroundRouting` | global | auto/same/fast/cheap/quality |
| `ai.personalInstructions` | global | enabled + bounded text |
| `voice.provider` | node | provider id |
| `voice.voiceName` | node | voice id |
| `voice.wake` | node | enabled + detector id |
| `desktop.startMode` | node | normal/expanded/compact/orb |
| `desktop.rememberBounds` | node | boolean |

### API

- `GET /preferences` → only registered user-facing preferences.
- `PUT /preferences/:key` → validate schema + allowed scope.
- `POST /preferences/:key/undo` → existing undo primitive.
- Include `revision` and `applies` metadata: immediate / next-turn / next-session / next-voice-session / desktop-restart. `next-turn` is what personal instructions need: the text reaches the model on the next turn, which is neither "now" nor "when the session is recreated".
- No secret values in preference API.

### Done

- arbitrary unknown key returns `PREFERENCE_UNKNOWN`;
- invalid shape refused before storage;
- undo works;
- no migration if existing preferences table is sufficient;
- Settings can subscribe/refetch without knowing DB layout.

---
