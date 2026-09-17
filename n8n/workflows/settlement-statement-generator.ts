import { expr, node, trigger, workflow } from "@n8n/workflow-sdk";

const monthlySchedule = trigger({
	type: "n8n-nodes-base.scheduleTrigger",
	version: 1.4,
	config: {
		name: "Monthly Statement Schedule",
		parameters: {
			rule: {
				interval: [
					{
						field: "months",
						monthsInterval: 1,
						triggerAtDayOfMonth: 1,
						triggerAtHour: 10,
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

const getSettlements = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Get Settlements",
		parameters: {
			method: "GET",
			url: expr(
				"{{ 'http://api:8000/settlements?period=' + $today.toFormat('yyyy-MM') }}",
			),
			authentication: "none",
			options: {
				timeout: 10000,
				response: {
					response: {
						responseFormat: "json",
					},
				},
			},
		},
	},
	output: [
		{
			items: [
				{
					contributor_id: "c1",
					period: "2026-09",
					revenue: 2000,
					usage_count: 15,
					content_statuses: { "content-1": "published" },
					usage_items: [
						{
							content_id: "content-1",
							usage_count: 10,
							unit_price: 100,
							amount: 1000,
						},
					],
				},
			],
		},
	],
});

const splitSettlements = node({
	type: "n8n-nodes-base.splitOut",
	version: 1,
	config: {
		name: "Split Settlements",
		parameters: {
			fieldToSplitOut: "items",
			include: "noOtherFields",
		},
	},
	output: [
		{
			contributor_id: "c1",
			period: "2026-09",
			revenue: 2000,
			usage_count: 15,
			content_statuses: { "content-1": "published" },
			usage_items: [
				{
					content_id: "content-1",
					usage_count: 10,
					unit_price: 100,
					amount: 1000,
				},
			],
		},
	],
});

const createStatement = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Create Statement",
		parameters: {
			method: "POST",
			url: "http://api:8000/settlement-statements",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $json.period + ':statement:' + $json.contributor_id, contributor_id: $json.contributor_id, period: $json.period, usage_items: $json.usage_items } }}",
			),
			options: {
				timeout: 10000,
				response: {
					response: {
						responseFormat: "json",
					},
				},
			},
		},
	},
	output: [
		{
			statement_id: "2026-09:statement:c1",
			contributor_id: "c1",
			period: "2026-09",
			usage_items: [
				{
					content_id: "content-1",
					usage_count: 10,
					unit_price: 100,
					amount: 1000,
				},
			],
			total: 1000,
			replayed: false,
		},
	],
});

export default workflow(
	"phase-2-settlement-statement-generator",
	"Phase 2 - Generate Settlement Statements",
)
	.add(monthlySchedule)
	.to(getSettlements)
	.to(splitSettlements)
	.to(createStatement);
