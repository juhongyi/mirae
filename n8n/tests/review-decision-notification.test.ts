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

test("review reason codes map to stable detailed guidance", async () => {
	const [result] = await runCode(
		"review-decision-notification.ts",
		"Build Review Rejection Message",
		[{ json: { event_id: "decision-1", reasons: ["copyright_risk", "visual_quality"] } }],
	);
	assert.equal(
		result.json.message,
		"반려 사유: [저작권 위험] 사용 권리를 확인하고 필요한 권리 증빙을 제출해 주세요. [시각 품질 기준] 깨짐, 정렬과 마감 상태를 확인해 품질 문제를 수정해 주세요.",
	);
});
