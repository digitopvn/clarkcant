import type { InstalledPackageView } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * How a package's trust lane is worded, in one place.
 *
 * AGENTS.md names showing a native Pi extension and an isolated widget with the same wording as "the
 * one mistake that list exists to prevent", so the wording lives here and every surface imports it
 * instead of keeping its own copy that can drift.
 */
const LANE_LABEL_KEY: Record<InstalledPackageView["lane"], MessageKey> = {
	declarative: "widgets.provenanceLane.declarative",
	"isolated-ui": "widgets.provenanceLane.isolatedUi",
	service: "widgets.provenanceLane.service",
	"trusted-native": "widgets.provenanceLane.trustedNative",
};

/** Where a package came from, as far as this node can say. */
export type ProvenanceKind = "installed" | "local";

export interface ProvenanceRow {
	packageId: string;
	version: string;
	/** Shortened for display. A digest is not a secret, but a 64-character string is unreadable. */
	digest: string;
	/** Kept so the shortened form can still be expanded on demand. */
	fullDigest: string;
	sourceTier: string;
	sourceRationale: string;
	lane: InstalledPackageView["lane"];
	laneLabel: string;
	kind: ProvenanceKind;
}

/**
 * The shortening is a fixed prefix rather than an ellipsis in the middle, so two builds of the same
 * package always read the same and a person can compare two rows by eye.
 */
export function shortDigest(digest: string): string {
	return digest.slice(0, 12);
}

/**
 * Whether a package was installed from a source or is a local development package.
 *
 * Derived from the source tier the node already reports, because inventing a field for this would be
 * inventing a second trust model - the thing the issue explicitly rules out.
 */
export function provenanceKind(sourceTier: string): ProvenanceKind {
	return /local|path|dev/i.test(sourceTier) ? "local" : "installed";
}

/** The trust lane's wording, for a single package outside the full row list. */
export function laneLabel(lane: InstalledPackageView["lane"], t: (key: MessageKey) => string): string {
	return t(LANE_LABEL_KEY[lane]);
}

export function provenanceRows(
	packages: readonly InstalledPackageView[],
	t: (key: MessageKey) => string,
): ProvenanceRow[] {
	return packages.map((entry) => ({
		packageId: entry.packageId,
		version: entry.version,
		digest: shortDigest(entry.digest),
		fullDigest: entry.digest,
		sourceTier: entry.source.sourceTier,
		sourceRationale: entry.source.rationale,
		lane: entry.lane,
		laneLabel: laneLabel(entry.lane, t),
		kind: provenanceKind(entry.source.sourceTier),
	}));
}

/**
 * What the library calls an entry that ships with Clark.
 *
 * The gallery's entries are not packages, so they are labelled by what they are rather than being
 * given a version and a digest they do not have.
 */
export function builtInLabel(t: (key: MessageKey) => string): string {
	return t("widgets.provenance.builtInLabel");
}
