import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import anomalyWorkflow from "../workflows/settlement-anomaly-monitor";
import statementWorkflow from "../workflows/settlement-statement-generator";
import svgWorkflow from "../workflows/svg-conversion";

type WorkflowInternals = {
	_nodes: Map<
		string,
		{ instance: { config: { parameters: { jsCode: string } } } }
	>;
};

const unwrap = <T>(loaded: unknown): T => {
	const value = loaded as WorkflowInternals & { default?: WorkflowInternals };
	return (value.default ?? value) as unknown as T;
};

function codeOf(loaded: unknown, nodeName: string): string {
	const workflow = unwrap<WorkflowInternals>(loaded);
	const code = workflow._nodes.get(nodeName)?.instance.config.parameters.jsCode;
	assert.ok(code, `missing jsCode for node ${nodeName}`);
	return code;
}

const require = createRequire(import.meta.url);

function fmtPeriod(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

const now = new Date();
const currentPeriod = fmtPeriod(
	new Date(now.getFullYear(), now.getMonth() - 1, 1),
);
const previousPeriod = fmtPeriod(
	new Date(now.getFullYear(), now.getMonth() - 2, 1),
);

const settlement = (
	contributorId: string,
	period: string,
	revenue: number,
	usageCount: number,
	extra: Record<string, unknown> = {},
) => ({
	contributor_id: contributorId,
	period,
	revenue,
	usage_count: usageCount,
	content_statuses: {},
	usage_items: [],
	...extra,
});

const anomalyCode = codeOf(anomalyWorkflow, "Detect Settlement Anomalies");

function detect(items: unknown[]) {
	const input = { all: () => [{ json: { items } }] };
	const execute = new Function("$input", anomalyCode);
	return execute(input);
}

test("detects a revenue drop when usage stays the same", () => {
	const items = [
		settlement("c1", previousPeriod, 10000, 100),
		settlement("c1", currentPeriod, 5000, 100),
	];
	const result = detect(items);
	assert.equal(result.length, 1);
	assert.equal(result[0].json.contributor_id, "c1");
	assert.match(result[0].json.detail, /수익 급감/);
});

test("detects a content-level zero revenue change", () => {
	const items = [
		settlement("c1", previousPeriod, 10000, 100, {
			usage_items: [{ content_id: "content-1", amount: 10000 }],
		}),
		settlement("c1", currentPeriod, 10000, 100, {
			usage_items: [{ content_id: "content-1", amount: 0 }],
		}),
	];
	const result = detect(items);
	assert.equal(result.length, 1);
	assert.match(result[0].json.detail, /0원 급변/);
});

test("detects unpublished content", () => {
	const items = [
		settlement("c1", previousPeriod, 10000, 100, {
			content_statuses: { "content-1": "published" },
		}),
		settlement("c1", currentPeriod, 10000, 100, {
			content_statuses: { "content-1": "unpublished" },
		}),
	];
	const result = detect(items);
	assert.equal(result.length, 1);
	assert.match(result[0].json.detail, /비공개 처리/);
});

test("emits nothing for normal data", () => {
	const items = [
		settlement("c1", previousPeriod, 10000, 100),
		settlement("c1", currentPeriod, 12000, 120),
	];
	assert.equal(detect(items).length, 0);
});

const statementCode = codeOf(statementWorkflow, "Build Statements");

function buildStatements(items: unknown[]) {
	const input = { all: () => [{ json: { items } }] };
	const execute = new Function("$input", statementCode);
	return execute(input);
}

test("builds a per-contributor statement with total and line items", () => {
	const items = [
		settlement("c1", currentPeriod, 2000, 15, {
			usage_items: [
				{
					content_id: "content-1",
					usage_count: 10,
					unit_price: 100,
					amount: 1000,
				},
				{
					content_id: "content-2",
					usage_count: 5,
					unit_price: 200,
					amount: 1000,
				},
			],
		}),
	];
	const result = buildStatements(items);
	assert.equal(result.length, 1);
	assert.equal(result[0].json.contributor_id, "c1");
	assert.match(result[0].json.detail, /합계 2000원/);
	assert.match(result[0].json.detail, /content-1 x10 @100 = 1000/);
});

const conversionCode = codeOf(svgWorkflow, "Convert SVG");

function convert(svgContent: string) {
	const input = {
		first: () => ({
			json: {
				body: {
					event_id: "event-1",
					submission_id: "submission-1",
					svg_content: svgContent,
				},
			},
		}),
	};
	const execute = new Function("$input", "require", conversionCode);
	return execute(input, require)[0].json as {
		success: boolean;
		converted_content: string | null;
		changed: boolean;
		error: string | null;
	};
}

test("converts evenodd paths and passes render comparison", () => {
	const result = convert(
		'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path fill-rule="evenodd" d="M0 0L100 0L100 100L0 100Z M10 10L90 10L90 90L10 90Z"/></svg>',
	);
	assert.equal(result.success, true);
	assert.equal(result.changed, true);
	assert.equal(result.error, null);
	assert.match(result.converted_content ?? "", /nonzero/);
});

test("passes through SVGs without evenodd", () => {
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path d="M0 0L100 0L100 100L0 100Z"/></svg>';
	const result = convert(svg);
	assert.equal(result.success, true);
	assert.equal(result.changed, false);
	assert.equal(result.converted_content, svg);
});

test("fails for unsupported path commands", () => {
	const result = convert(
		'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path fill-rule="evenodd" d="X 0 0"/></svg>',
	);
	assert.equal(result.success, false);
	assert.equal(result.converted_content, null);
	assert.match(result.error ?? "", /지원하지 않는 SVG 경로 명령/);
});
