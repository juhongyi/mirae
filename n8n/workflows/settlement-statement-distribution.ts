import { expr, ifElse, node, trigger, workflow } from "@n8n/workflow-sdk";

const monthlySchedule = trigger({
	type: "n8n-nodes-base.scheduleTrigger",
	version: 1.4,
	config: {
		name: "Monthly Settlement Statement Distribution",
		parameters: {
			rule: {
				interval: [
					{
						field: "months",
						monthsInterval: 1,
						triggerAtDayOfMonth: 1,
						triggerAtHour: 3,
						triggerAtMinute: 0,
					},
				],
			},
			misfirePolicy: "coalesce_owner",
			misfireGraceSeconds: 0,
			skipDurableScheduler: false,
		},
	},
});

const getPeriodSettlements = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Get Completed Period Settlements",
		parameters: {
			method: "GET",
			url: expr(
				"{{ 'http://api:8000/settlements?period=' + $today.minus({ months: 1 }).toFormat('yyyy-MM') }}",
			),
			authentication: "none",
			options: {
				timeout: 10000,
				response: { response: { responseFormat: "json" } },
			},
		},
	},
	output: [{ items: [] }],
});

const buildStatements = node({
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Build Settlement Statements",
		parameters: {
			mode: "runOnceForAllItems",
			jsCode: `const rows = $input.all().flatMap((item) => Array.isArray(item.json.items) ? item.json.items : [item.json]);
const now = new Date();
const completedDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const period = completedDate.getUTCFullYear() + "-" + String(completedDate.getUTCMonth() + 1).padStart(2, "0");
const statements = new Map();

rows
	.filter((row) => row && row.period === period && row.contributor_id && Array.isArray(row.usage_items) && row.usage_items.length > 0)
	.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
	.forEach((row) => {
		if (statements.has(row.contributor_id)) return;
		const total = row.usage_items.reduce((sum, item) => {
			const amount = Number(item.amount);
			return sum + (Number.isFinite(amount) ? amount : 0);
		}, 0);
		statements.set(row.contributor_id, {
			event_id: "settlement-statement:" + period + ":" + row.contributor_id,
			contributor_id: row.contributor_id,
			period,
			usage_items: row.usage_items,
			total,
		});
	});

return [{ json: { items: [...statements.values()].sort((left, right) => left.contributor_id.localeCompare(right.contributor_id)) } }];`,
		},
	},
	output: [{ items: [] }],
});

const hasStatements = ifElse({
	version: 2.3,
	config: {
		name: "Has Completed Statements",
		parameters: {
			conditions: {
				combinator: "and",
				options: {
					caseSensitive: true,
					leftValue: "",
					typeValidation: "strict",
					version: 2,
				},
				conditions: [
					{
						leftValue: expr("{{ $json.items.length }}"),
						rightValue: 0,
						operator: { type: "number", operation: "gt" },
					},
				],
			},
			looseTypeValidation: false,
		},
	},
	output: [{ items: [{}] }],
});

const splitStatements = node({
	type: "n8n-nodes-base.splitOut",
	version: 1,
	config: {
		name: "Split Statements",
		parameters: {
			fieldToSplitOut: "items",
			options: {},
		},
	},
	output: [{ event_id: "settlement-statement:2026-09:contributor-1" }],
});

const createStatement = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Create Settlement Statement",
		parameters: {
			method: "POST",
			url: "http://api:8000/settlement-statements",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $json.event_id, contributor_id: $json.contributor_id, period: $json.period, usage_items: $json.usage_items, total: $json.total } }}",
			),
			options: {
				timeout: 10000,
				response: { response: { responseFormat: "json" } },
			},
		},
	},
	output: [{ event_id: "settlement-statement:2026-09:contributor-1" }],
});

const notifyContributor = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Distribute Settlement Statement",
		parameters: {
			method: "POST",
			url: "http://api:8000/notifications",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $('Split Statements').item.json.event_id + ':notification', recipient_id: $('Split Statements').item.json.contributor_id, kind: 'settlement_statement', reference_event_id: $('Split Statements').item.json.event_id, message: $('Split Statements').item.json.period + ' 정산 상세 명세가 생성되었습니다.' } }}",
			),
			options: {
				timeout: 10000,
				response: { response: { responseFormat: "json" } },
			},
		},
	},
	output: [
		{ event_id: "settlement-statement:2026-09:contributor-1:notification" },
	],
});

export default workflow(
	"phase-2-settlement-statement-distribution",
	"Phase 2 - Distribute Settlement Statements",
)
	.add(monthlySchedule)
	.to(getPeriodSettlements)
	.to(buildStatements)
	.to(
		hasStatements.onTrue(
			splitStatements.to(createStatement).to(notifyContributor),
		),
	);
