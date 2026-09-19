import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflows = new URL("../workflows/", import.meta.url);

async function codeFrom(file: string, name: string): Promise<string> {
	const source = await readFile(new URL(file, workflows), "utf8");
	const start = source.indexOf(`name: "${name}"`);
	assert.notEqual(start, -1, `Code node ${name} was not found`);
	const match = source.slice(start).match(/jsCode:\s*`([\s\S]*?)`/);
	assert.ok(match, `Code node ${name} has no template-literal jsCode`);
	return match[1];
}

async function runCode(
	file: string,
	name: string,
	items: Array<{ json: Record<string, unknown> }>,
	nodes: Record<string, Array<{ json: Record<string, unknown> }>> = {},
	now = "2026-09-18T09:00:00.000Z",
) {
	const code = await codeFrom(file, name);
	const input = { all: () => items, first: () => items[0] };
	const select = (nodeName: string) => ({
		all: () => nodes[nodeName],
		first: () => nodes[nodeName][0],
	});
	const FixedDate = class extends Date {
		constructor(value?: string | number | Date) {
			super(value ?? now);
		}
		static override now() {
			return new Date(now).valueOf();
		}
	};
	return await new Function("$input", "$", "Date", `return (async () => { ${code} })();`)(
		input,
		select,
		FixedDate,
	);
}

async function checkSla(items: Array<Record<string, unknown>>) {
	return await runCode("review-queue-sla-monitor.ts", "Calculate SLA Breaches", [
		{ json: { items } },
	]);
}

test("SLA exact thresholds do not breach", async () => {
	const items = Array.from({ length: 20 }, (_, index) => ({
		submission_id: `submission-${index}`,
		submitted_at: index === 0 ? "2026-09-08T09:00:00.000Z" : "2026-09-18T09:00:00.000Z",
	}));
	const [result] = await checkSla(items);
	assert.equal(result.json.longest_wait_days, 10);
	assert.deepEqual(result.json.breaches, []);
});

test("SLA detects a fractional wait breach", async () => {
	const [result] = await checkSla([
		{ submission_id: "submission-1", submitted_at: "2026-09-08T08:59:59.000Z" },
	]);
	assert.deepEqual(result.json.breaches.map((item: { metric: string }) => item.metric), [
		"longest_wait_days",
	]);
});

test("SLA reports both metrics in stable order", async () => {
	const items = Array.from({ length: 21 }, (_, index) => ({
		submission_id: `submission-${index}`,
		submitted_at: "2026-09-01T09:00:00.000Z",
	}));
	const [result] = await checkSla(items);
	assert.equal(result.json.event_id, "review-sla:2026-09-18");
	assert.equal(result.json.checked_at, "2026-09-18T09:00:00.000Z");
	assert.deepEqual(result.json.breaches.map((item: { metric: string }) => item.metric), [
		"longest_wait_days",
		"queue_size",
	]);
	assert.match(result.json.message, /longest_wait_days, queue_size/);
});

test("SLA handles an empty queue", async () => {
	const [result] = await checkSla([]);
	assert.equal(result.json.queue_size, 0);
	assert.equal(result.json.longest_wait_days, 0);
	assert.deepEqual(result.json.breaches, []);
});
