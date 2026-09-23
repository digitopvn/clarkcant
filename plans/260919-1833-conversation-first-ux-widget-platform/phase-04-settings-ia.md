---
title: "Phase 4 — Settings IA & component primitives (~10h)"
status: done
---

# Phase 4 — Settings IA & component primitives (~10h)

### Mục tiêu

Thay General/Models/Tools/Devices bằng IA user-centric:

1. Experience
2. AI & Routing
3. Control
4. Extensions & Widgets
5. Devices & Voice
6. Developer / Advanced (progressive disclosure)

### Refactor

Tách `SettingsPanel.tsx` thành:
- `settings/SettingsPanel.tsx`
- `settings/ExperienceSettings.tsx`
- `settings/AiRoutingSettings.tsx`
- `settings/ControlSettings.tsx`
- `settings/ExtensionsSettings.tsx`
- `settings/DevicesVoiceSettings.tsx`
- `settings/DeveloperSettings.tsx`
- `settings/controls/*`

Không để file monolith tiếp tục lớn.

### Correct controls

- segmented: theme/motion/density/execution mode;
- switch: booleans;
- search-select: provider/model/voice/package;
- slider + numeric field: Orb advanced physics;
- swatch/preset cards: Orb profile;
- textarea: personal instructions / Jev instructions;
- button: one-shot action;
- details/subpanel: diagnostics/raw Pi settings.

### Experience

Orb preview là live interactive preview, nhưng chỉ một Orb renderer; không render grid nhiều WebGL canvases cùng lúc. Preset list dùng static swatch, selected preset feed preview.

### Developer tab

Move:
- node ID;
- raw Pi settings;
- Pi extension file names;
- capability refs;
- budgets/limits;
- contrast/debug specimens.

### E2E

Keyboard tab navigation, autosave, status, focus restore, narrow viewport.

---
