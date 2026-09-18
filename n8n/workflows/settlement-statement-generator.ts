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
						triggerAtDayOfMonth: 25,
						triggerAtHour: 9,
						triggerAtMinute: 30,
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
			url: "http://api:8000/settlements",
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
					period: "2026-08",
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
						{
							content_id: "content-2",
							usage_count: 5,
							unit_price: 200,
							amount: 1000,
						},
					],
				},
			],
		},
	],
});

const buildStatements = node({
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Build Statements",
		parameters: {
			mode: "runOnceForAllItems",
			language: "javaScript",
			jsCode: `
function fmtPeriod(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}
function previousMonthPeriod() {
  const now = new Date();
  return fmtPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

const input = $input.all()[0].json;
const period = previousMonthPeriod();
const settlements = (input.items ?? []).filter((item) => item.period === period);

return settlements.map((settlement) => {
  const items = settlement.usage_items ?? [];
  const total = items.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const lines = items.map(
    (item) => item.content_id + " x" + item.usage_count + " @" + item.unit_price + " = " + item.amount,
  );
  const detail = [
    period + " 정산 명세 (합계 " + total + "원)",
    ...lines,
  ].join("\\n");
  return { json: { period, contributor_id: settlement.contributor_id, detail } };
});
`,
		},
	},
	output: [
		{
			period: "2026-08",
			contributor_id: "c1",
			detail:
				"2026-08 정산 명세 (합계 2000원)\ncontent-1 x10 @100 = 1000\ncontent-2 x5 @200 = 1000",
		},
	],
});

const notifyContributor = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Distribute Statement",
		parameters: {
			method: "POST",
			url: "http://api:8000/notifications",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $json.period + ':statement:' + $json.contributor_id, recipient_id: $json.contributor_id, kind: 'settlement_statement', detail: $json.detail } }}",
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
			event_id: "2026-08:statement:c1",
			recipient_id: "c1",
			kind: "settlement_statement",
			message:
				"2026-08 정산 명세 (합계 2000원)\ncontent-1 x10 @100 = 1000\ncontent-2 x5 @200 = 1000",
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
	.to(buildStatements)
	.to(notifyContributor);
