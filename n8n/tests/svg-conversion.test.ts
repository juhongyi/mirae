import assert from "node:assert/strict";
import test from "node:test";

import loadedWorkflow from "../workflows/svg-conversion";

type WorkflowInternals = {
	_nodes: Map<string, { instance: { config: { parameters: { jsCode: string } } } }>;
};

const imported = loadedWorkflow as unknown as WorkflowInternals & {
	default?: WorkflowInternals;
};
const workflow = imported.default ?? imported;
const conversionCode = workflow._nodes.get("Convert SVG")?.instance.config.parameters
	.jsCode;

assert.ok(conversionCode);

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
	const execute = new Function("$input", conversionCode);
	return execute(input)[0].json as {
		success: boolean;
		converted_content: string | null;
		error: string | null;
	};
}

test("converts nested evenodd paths to opposite winding directions", () => {
	const result = convert(
		"M 0 0 L 100 0 L 100 100 L 0 100 Z M 10 10 L 90 10 L 90 90 L 10 90 Z",
	);

	assert.equal(result.success, true);
	assert.match(result.converted_content ?? "", /M 10 90 L 90 90/);
	assert.equal(result.error, null);
});

test("supports relative commands and curves", () => {
	const result = convert(
		"m0 50 c0 -50 100 -50 100 0 c0 50 -100 50 -100 0 z m25 0 c0 25 50 25 50 0 c0 -25 -50 -25 -50 0 z",
	);

	assert.equal(result.success, true);
	assert.match(result.converted_content ?? "", /C/);
});

test("returns a failure result for malformed paths", () => {
	const result = convert("not a valid svg path");

	assert.equal(result.success, false);
	assert.equal(result.converted_content, null);
	assert.match(result.error ?? "", /지원하지 않는 SVG 경로 명령/);
});
