import type { MessageBlock } from "@clarkcant/contracts";

/** The typed numbers a status card carries, when it carries any. */
export type TurnMetrics = Extract<MessageBlock, { type: "system-card" }>["metrics"];

/**
 * The numbers of the newest finished turn.
 *
 * The composer's statusline describes the session as the session last reported itself, which is the newest
 * card that carried numbers. Cards are read newest first because a turn that reported nothing - a scripted
 * sample, a capability - must not wipe what the last real turn said.
 */
export function latestTurnMetrics(blocks: readonly MessageBlock[]): TurnMetrics | undefined {
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (block?.type === "system-card" && block.metrics !== undefined) return block.metrics;
	}
	return undefined;
}

/** Tokens at a glance: nobody reads six digits when four will do. */
export function formatTokenCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(2)}M`;
}

/**
 * The session as one line of parts.
 *
 * Each part is a name and a number, in the order a reader asks about them: how full the context is, how much
 * of the input came back from the cache, how fast the model wrote, what it has cost, and what is running
 * behind the conversation. A part whose number was never reported is left out rather than shown as zero,
 * because "cache 0%" and "the provider said nothing about a cache" are different facts.
 */
export function statuslineParts(input: {
	metrics?: TurnMetrics;
	/** Background sessions by state, when the node counts any. */
	background?: { running: number; done: number; failed: number };
	/** The provider's own quota line, verbatim, when it publishes one. */
	quota?: string;
}): string[] {
	const parts: string[] = [];
	const metrics = input.metrics;

	if (metrics?.contextTokens !== undefined && metrics.contextWindow !== undefined && metrics.contextWindow > 0) {
		const share = Math.round((metrics.contextTokens / metrics.contextWindow) * 100);
		parts.push(`${formatTokenCount(metrics.contextTokens)}/${formatTokenCount(metrics.contextWindow)} (${share}%)`);
	}
	if (metrics?.cacheReadTokens !== undefined) {
		const reusable = metrics.cacheReadTokens + (metrics.inputTokens ?? 0);
		if (reusable > 0) parts.push(`cache ${Math.round((metrics.cacheReadTokens / reusable) * 100)}%`);
	}
	if (metrics?.tokensPerSecond !== undefined) parts.push(`${metrics.tokensPerSecond.toFixed(1)} tok/s`);
	if (metrics?.costUsd !== undefined) parts.push(`$${metrics.costUsd.toFixed(4)}`);

	const background = input.background;
	if (background !== undefined) {
		const running = background.running;
		const finished = background.done + background.failed;
		if (running > 0 || finished > 0) {
			const states: string[] = [];
			if (running > 0) states.push(`${running} đang chạy`);
			if (background.done > 0) states.push(`${background.done} xong`);
			if (background.failed > 0) states.push(`${background.failed} lỗi`);
			parts.push(`nền: ${states.join(", ")}`);
		}
	}
	if (input.quota !== undefined && input.quota !== "") parts.push(input.quota);

	return parts;
}
