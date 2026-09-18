import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowDirectory = new URL("../workflows/", import.meta.url);

function extractCode(fileName: string, nodeName: string): string {
	const source = readFileSync(new URL(fileName, workflowDirectory), "utf8");
	const escapedName = nodeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = source.match(
		new RegExp(
			'name: "' + escapedName + '"[\\s\\S]*?jsCode: `([\\s\\S]*?)`,',
		),
	);
	assert.ok(match, `Code node ${nodeName} was not found in ${fileName}`);
	return match[1];
}

async function runCode(
	fileName: string,
	nodeName: string,
	items: Array<Record<string, unknown>>,
	now = "2026-10-01T02:00:00Z",
) {
	const code = extractCode(fileName, nodeName);
	const FixedDate = class extends Date {
		constructor(value?: string | number | Date) {
			super(value ?? now);
		}
		static override now() {
			return new Date(now).valueOf();
		}
	};
	const execute = new Function("$input", "Date", `return (async () => {${code}})()`);
	return execute({ all: () => items.map((json) => ({ json })) }, FixedDate);
}

const usageItem = (contentId: string, amount: number) => ({
	content_id: contentId,
	usage_count: 1,
	unit_price: amount,
	amount,
});

test("anomaly thresholds include exact boundaries and exclude normal data", async () => {
	const result = await runCode(
		"settlement-anomaly-monitor.ts",
		"Evaluate Settlement Anomalies",
		[
			{
				items: [
					{ contributor_id: "boundary", period: "2026-08", revenue: 100, usage_count: 100 },
					{ contributor_id: "boundary", period: "2026-09", revenue: 70, usage_count: 80 },
					{ contributor_id: "normal", period: "2026-08", revenue: 100, usage_count: 100 },
					{ contributor_id: "normal", period: "2026-09", revenue: 71, usage_count: 80 },
				],
			},
		],
	);

	assert.deepEqual(result[0].json.items.map((item: any) => item.contributor_id), ["boundary"]);
	assert.deepEqual(result[0].json.items[0].anomalies.map((item: any) => item.rule), ["revenue_drop"]);
});

test("anomalies require previous data and detect content zero revenue independently", async () => {
	const result = await runCode(
		"settlement-anomaly-monitor.ts",
		"Evaluate Settlement Anomalies",
		[
			{
				items: [
					{
						contributor_id: "affected",
						period: "2026-08",
						revenue: 100,
						usage_count: 10,
						usage_items: [usageItem("zero", 40), usageItem("positive", 60)],
					},
					{
						contributor_id: "affected",
						period: "2026-09",
						revenue: 60,
						usage_count: 10,
						usage_items: [usageItem("positive", 60)],
					},
					{ contributor_id: "new", period: "2026-09", revenue: 1, usage_count: 1 },
				],
			},
		],
	);

	assert.equal(result[0].json.items.length, 1);
	assert.equal(result[0].json.items[0].contributor_id, "affected");
	assert.ok(result[0].json.items[0].anomalies.some((item: any) => item.rule === "content_zero_revenue"));
	assert.match(result[0].json.items[0].message, /확인이 필요한 이상 징후/);
});

test("unpublished transitions and multiple contributors are deterministic and deduplicated", async () => {
	const result = await runCode(
		"settlement-anomaly-monitor.ts",
		"Evaluate Settlement Anomalies",
		[
			{
				items: [
					{ contributor_id: "z", period: "2026-08", revenue: 10, usage_count: 1, content_statuses: { c1: "published" } },
					{ contributor_id: "a", period: "2026-08", revenue: 10, usage_count: 1, content_statuses: { c2: "published" } },
					{ contributor_id: "z", period: "2026-09", revenue: 10, usage_count: 1, content_statuses: { c1: "unpublished" } },
					{ contributor_id: "a", period: "2026-09", revenue: 10, usage_count: 1, content_statuses: { c2: "unpublished" } },
				],
			},
		],
	);

	assert.deepEqual(result[0].json.items.map((item: any) => item.contributor_id), ["a", "z"]);
	for (const item of result[0].json.items) {
		assert.equal(new Set(item.anomalies.map((anomaly: any) => `${anomaly.rule}:${anomaly.content_id ?? ""}`)).size, item.anomalies.length);
	}
});

test("statements calculate totals and deterministic event IDs", async () => {
	const result = await runCode(
		"settlement-statement-distribution.ts",
		"Build Settlement Statements",
		[
			{
				items: [
					{ contributor_id: "z", period: "2026-09", usage_items: [usageItem("c1", 11), usageItem("c2", 4)] },
					{ contributor_id: "a", period: "2026-09", usage_items: [usageItem("c3", 7)] },
				],
			},
		],
	);

	assert.deepEqual(result[0].json.items.map((item: any) => [item.contributor_id, item.total]), [["a", 7], ["z", 15]]);
	assert.equal(result[0].json.items[0].event_id, "settlement-statement:2026-09:a");
});

test("statement generation handles empty responses and skips incomplete statements", async () => {
	const empty = await runCode(
		"settlement-statement-distribution.ts",
		"Build Settlement Statements",
		[{ items: [] }],
	);
	const incomplete = await runCode(
		"settlement-statement-distribution.ts",
		"Build Settlement Statements",
		[{ items: [{ contributor_id: "a", period: "2026-09", usage_items: [] }] }],
	);

	assert.deepEqual(empty, [{ json: { items: [] } }]);
	assert.deepEqual(incomplete, [{ json: { items: [] } }]);
});
