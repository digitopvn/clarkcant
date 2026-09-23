import type { MemoryKind, MemoryRecord, MemoryScope } from "@clarkcant/contracts";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * How a remembered thing reads on a screen.
 *
 * Pure, so the labels and the grouping are tested without a DOM. The same rule as the suggestion labels applies
 * here: nothing is written down that is a fact about the records, because "yesterday" on a record from last week is
 * a lie the person can check by looking at the date next to it. Each function takes a `t` lookup rather than calling
 * `useT()`, since these run outside a component.
 */

const MEMORY_KIND_LABEL_KEY: Record<MemoryKind, MessageKey> = {
	preference: "widgets.memory.kind.preference",
	"project-fact": "widgets.memory.kind.projectFact",
	decision: "widgets.memory.kind.decision",
};

const KIND_ORDER: readonly MemoryKind[] = ["preference", "project-fact", "decision"];

export interface MemoryRowView {
	memoryId: string;
	text: string;
	kind: MemoryKind;
	kindLabel: string;
	/** Why it is here, in words: which conversation, or which message. */
	sourceLabel: string;
	/** How long ago, computed. */
	timeLabel: string;
	scopeLabel: string;
}

export interface MemoryGroupView {
	kind: MemoryKind;
	label: string;
	rows: readonly MemoryRowView[];
}

export interface MemoryView {
	groups: readonly MemoryGroupView[];
	count: number;
}

/** How long ago something was written, in words rather than in a stamp nobody reads. */
export function timeLabel(at: string, now: string, t: (key: MessageKey) => string): string {
	const then = Date.parse(at);
	const current = Date.parse(now);
	if (!Number.isFinite(then) || !Number.isFinite(current)) return "";
	const days = Math.floor((current - then) / 86_400_000);
	if (days <= 0) return t("widgets.memory.time.today");
	if (days === 1) return t("widgets.memory.time.yesterday");
	if (days < 7) return t("widgets.memory.time.daysAgo").replace("{days}", String(days));
	// Past a week, the date is more use than a count of days.
	return new Date(then).toISOString().slice(0, 10);
}

/** Whether this is about the person or about the conversation they were in. */
export function scopeLabel(scope: MemoryScope, t: (key: MessageKey) => string): string {
	return t(scope === "node" ? "widgets.memory.scope.node" : "widgets.memory.scope.conversation");
}

/**
 * Where it came from, by id.
 *
 * The id is shortened rather than shown in full, and the content of the message is never quoted: this row exists to
 * say where the thing came from so the person can go and look, not to show them their own words again.
 */
export function sourceLabel(record: MemoryRecord, t: (key: MessageKey) => string): string {
	const short = (value: string): string => (value.length <= 10 ? value : `${value.slice(0, 10)}…`);
	if (record.sourceMessageId !== undefined) {
		return t("widgets.memory.sourceMessage").replace("{id}", short(record.sourceMessageId));
	}
	return t("widgets.memory.sourceConversation").replace("{id}", short(record.sourceConversationId));
}

export function memoryRow(record: MemoryRecord, now: string, t: (key: MessageKey) => string): MemoryRowView {
	return {
		memoryId: record.memoryId,
		text: record.text,
		kind: record.kind,
		kindLabel: t(MEMORY_KIND_LABEL_KEY[record.kind]),
		sourceLabel: sourceLabel(record, t),
		timeLabel: timeLabel(record.at, now, t),
		scopeLabel: scopeLabel(record.scope, t),
	};
}

/**
 * The rows, grouped by what kind of thing they are.
 *
 * Kinds with nothing in them are left out rather than shown as empty headings, and the order is fixed rather than
 * whatever the records happened to arrive in: a screen whose sections move around is one nobody can learn.
 */
export function memoryView(records: readonly MemoryRecord[], now: string, t: (key: MessageKey) => string): MemoryView {
	const groups = KIND_ORDER.map((kind) => ({
		kind,
		label: t(MEMORY_KIND_LABEL_KEY[kind]),
		rows: records.filter((record) => record.kind === kind).map((record) => memoryRow(record, now, t)),
	})).filter((group) => group.rows.length > 0);

	return { groups, count: records.length };
}
