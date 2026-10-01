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
});
