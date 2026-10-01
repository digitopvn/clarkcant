import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CATALOG, type RendererProps } from "../src/renderers.tsx";

function render(definitionId: string, props: Record<string, unknown>, state?: Record<string, unknown>): string {
  const renderer = CATALOG[definitionId];
  if (renderer === undefined) throw new Error(`${definitionId} has no renderer`);
  const input: RendererProps = {
    definitionId,
    props,
    dataset: undefined,
    imageUrl: (ref: string) => `blob:test/${ref}`,
    state,
  };
  return renderToStaticMarkup(createElement(renderer, input));
}

const PICTURES = { imageRefs: ["one", "two", "three"], alts: ["First", "Second", "Third"] };

describe("media renderers", () => {
  it("draws a stored carousel or gallery that has no state at its first item", () => {
    expect(render("canvas.carousel@1", PICTURES)).toContain('data-carousel-index="0"');
    const gallery = render("canvas.gallery@1", PICTURES);
    expect(gallery.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(gallery).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*data-image-ref="one"/);
  });

  it("opens at the held selection, normalized against the pictures it has now", () => {
    expect(render("canvas.carousel@1", PICTURES, { selectedIndex: 1 })).toContain('data-carousel-index="1"');
    expect(render("canvas.carousel@1", PICTURES, { selectedIndex: 9 })).toContain('data-carousel-index="2"');
    expect(render("canvas.gallery@1", PICTURES, { selectedIndex: 2 })).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*data-image-ref="three"/);
  });

  it("keeps a gallery caption outside its selection button", () => {
    const gallery = render("canvas.gallery@1", PICTURES);
    expect(gallery).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<figcaption/);
    expect(gallery).toContain("<figcaption");
  });

  it("restores a video that was playing without asking it to play", () => {
    const video = render("canvas.video@1", { videoRef: "clip", alt: "A short clip" }, { status: "playing", position: 12, duration: 30 });
    expect(video).toContain('src="blob:test/clip"');
    expect(video).not.toContain("autoplay");
    expect(video).not.toContain("autoPlay");
  });

  it("says beside each media widget why the node refused its last change", () => {
    const refusal = { message: "This could not be done. Nothing was changed.", viewReset: 1 };
    for (const [definitionId, props, name] of [
      ["canvas.carousel@1", PICTURES, "carousel"],
      ["canvas.gallery@1", PICTURES, "gallery"],
      ["canvas.video@1", { videoRef: "clip", alt: "A short clip" }, "video"],
    ] as const) {
      const drawn = render(definitionId, props, { ...refusal, selectedIndex: 1 });
      expect(drawn).toContain(`data-media-message="${name}"`);
      expect(drawn).toMatch(/role="status"[^>]*>This could not be done\. Nothing was changed\.</);
      // No refusal, no sentence.
      expect(render(definitionId, props, { selectedIndex: 1 })).not.toContain("data-media-message");
    }
    // The carousel draws the picture the node holds next to the refusal, not the one that was refused.
    expect(render("canvas.carousel@1", PICTURES, { ...refusal, selectedIndex: 1 })).toContain('data-carousel-index="1"');
  });

  it("names a picture without a description by its place, in the reader's language", () => {
    const gallery = render("canvas.gallery@1", { imageRefs: ["one", "two"] });
    expect(gallery).not.toMatch(/aria-label="\d+\/\d+"/);
    expect(gallery).toMatch(/aria-label="(?:Ảnh 2\/2|Picture 2 of 2)"/);
  });
});
