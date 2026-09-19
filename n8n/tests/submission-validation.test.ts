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

const submission = {
	event_id: "submission-event-1",
	submission_id: "submission-1",
	contributor_id: "contributor-1",
	content_type: "svg",
	format: "svg",
	width: 1000,
	height: 1000,
	file_size_bytes: 100_000,
	svg_attributes: {},
	element_count: 100,
	whitespace_ratio: 0.2,
	submitted_at: "2026-09-01T09:00:00.000Z",
};

async function validate(overrides: Record<string, unknown>) {
	return await runCode(
		"submission-validation.ts",
		"Evaluate Submission Rules",
		[{ json: { event_id: submission.event_id } }],
		{
			"Receive Submission": [{ json: { body: { ...submission, ...overrides } } }],
		},
	);
}

test("submission validation returns every violation in stable policy order", async () => {
	const [result] = await validate({
		format: "pdf",
		width: 99,
		file_size_bytes: 153_601,
		svg_attributes: { "fill-rule": "EVENODD", stroke: "none" },
		element_count: 1001,
		whitespace_ratio: 0.51,
	});
	assert.equal(result.json.valid, false);
	assert.deepEqual(
		result.json.violations.map((item: { rule: string }) => item.rule),
		["file_specification", "forbidden_attribute", "element_count", "whitespace_ratio"],
	);
	assert.deepEqual(result.json.violations[0], {
		rule: "file_specification",
		name: "파일 규격",
		guidance: "지원 형식, 크기와 해상도 기준에 맞게 파일을 수정해 주세요.",
	});
});

test("submission validation accepts exact policy boundaries", async () => {
	const [result] = await validate({
		width: 100,
		height: 10_000,
		file_size_bytes: 153_600,
		element_count: 1000,
		whitespace_ratio: 0.5,
	});
	assert.deepEqual(result.json.violations, []);
	assert.equal(result.json.valid, true);
});

test("image validation excludes SVG-only attribute and element rules", async () => {
	const [result] = await validate({
		content_type: "image",
		format: ".JPEG",
		file_size_bytes: 10 * 1024 * 1024,
		svg_attributes: { "fill-rule": "evenodd", stroke: "#000" },
		element_count: 1001,
	});
	assert.deepEqual(result.json.violations, []);
});
