import { describe, expect, it } from "vitest";

import { pinLabel } from "../src/ConversationPinSurfaces.tsx";

describe("the name a pin has on the shelf", () => {
  it("is the widget's title, or an action button's label", () => {
    expect(pinLabel({ title: "  Bảng có liên kết " })).toBe("Bảng có liên kết");
    expect(pinLabel({ label: "Ghim nút này" })).toBe("Ghim nút này");
    expect(pinLabel({ title: "Doanh thu", label: "Mở" })).toBe("Doanh thu");
  });

  it("is nothing when the widget was given no name, so the shelf says so rather than showing an id", () => {
    expect(pinLabel(undefined)).toBeUndefined();
    expect(pinLabel({ title: "   ", label: 3 })).toBeUndefined();
  });
});
