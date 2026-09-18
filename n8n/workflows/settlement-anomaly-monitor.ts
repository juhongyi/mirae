import { expr, node, trigger, workflow } from "@n8n/workflow-sdk";

const monitorSchedule = trigger({
	type: "n8n-nodes-base.scheduleTrigger",
	version: 1.4,
	config: {
		name: "Monthly Settlement Anomaly Check",
		parameters: {
			rule: {
				interval: [
					{
						field: "months",
						monthsInterval: 1,
						triggerAtDayOfMonth: 25,
						triggerAtHour: 9,
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
					revenue: 10000,
					usage_count: 100,
					content_statuses: { "content-1": "published" },
					usage_items: [
						{
							content_id: "content-1",
							usage_count: 100,
							unit_price: 100,
							amount: 10000,
						},
					],
				},
				{
					contributor_id: "c1",
					period: "2026-09",
					revenue: 5000,
					usage_count: 100,
					content_statuses: { "content-1": "published" },
					usage_items: [
						{
							content_id: "content-1",
							usage_count: 100,
							unit_price: 50,
							amount: 5000,
						},
					],
				},
			],
		},
	],
});

const detectCode = `
const REVENUE_RATIO_THRESHOLD = 0.7;
const USAGE_RATIO_THRESHOLD = 0.8;

function amounts(items) {
  const map = {};
  for (const item of items ?? []) {
    const id = item.content_id;
    map[id] = (map[id] ?? 0) + Number(item.amount ?? 0);
  }
  return map;
}

function fmtPeriod(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

function previousMonthPeriod() {
  const now = new Date();
  return fmtPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

function monthBeforePeriod() {
  const now = new Date();
  return fmtPeriod(new Date(now.getFullYear(), now.getMonth() - 2, 1));
}

function detect(current, previous) {
  const anomalies = [];
  if (previous) {
    if (previous.usage_count > 0 && previous.revenue > 0 && current.revenue > 0) {
      const usageRatio = current.usage_count / previous.usage_count;
      const revenueRatio = current.revenue / previous.revenue;
      if (usageRatio >= USAGE_RATIO_THRESHOLD && revenueRatio <= REVENUE_RATIO_THRESHOLD) {
        anomalies.push({
          rule: "revenue_drop",
          name: "수익 급감",
          guidance: "이전 주기 대비 사용량은 유지되는데 수익이 급감했습니다. 정산 내역을 확인해 주세요.",
        });
      }
    }
    const prevAmounts = amounts(previous.usage_items);
    const currAmounts = amounts(current.usage_items);
    for (const contentId of Object.keys(prevAmounts)) {
      if (prevAmounts[contentId] > 0 && (currAmounts[contentId] ?? 0) === 0) {
        anomalies.push({
          rule: "zero_revenue",
          name: "0원 급변",
          guidance: "콘텐츠 '" + contentId + "'가 이번 주기에 0원으로 집계되었습니다.",
        });
      }
    }
    const prevStatuses = previous.content_statuses ?? {};
    for (const contentId of Object.keys(current.content_statuses ?? {})) {
      if (current.content_statuses[contentId] === "unpublished" && prevStatuses[contentId] === "published") {
        anomalies.push({
          rule: "content_unpublished",
          name: "비공개 처리",
          guidance: "콘텐츠 '" + contentId + "'가 비공개 처리되었습니다.",
        });
      }
    }
  }
  return anomalies;
}

const input = $input.all()[0].json;
const period = previousMonthPeriod();
const previousPeriod = monthBeforePeriod();
const settlements = input.items ?? [];

const currentByContributor = {};
const previousByContributor = {};
for (const settlement of settlements) {
  if (settlement.period === period) {
    currentByContributor[settlement.contributor_id] = settlement;
  } else if (settlement.period === previousPeriod) {
    previousByContributor[settlement.contributor_id] = settlement;
  }
}

const output = [];
for (const contributorId of Object.keys(currentByContributor)) {
  const anomalies = detect(currentByContributor[contributorId], previousByContributor[contributorId]);
  if (anomalies.length) {
    const detail = anomalies.map((item) => "[" + item.name + "] " + item.guidance).join(" ");
    output.push({ json: { period, contributor_id: contributorId, detail } });
  }
}
return output;
`;

const detectAnomalies = node({
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Detect Settlement Anomalies",
		parameters: {
			mode: "runOnceForAllItems",
			language: "javaScript",
			jsCode: detectCode,
		},
	},
	output: [
		{
			period: "2026-08",
			contributor_id: "c1",
			detail:
				"[수익 급감] 이전 주기 대비 사용량은 유지되는데 수익이 급감했습니다. 정산 내역을 확인해 주세요.",
		},
	],
});

const notifyContributor = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Notify Contributor",
		parameters: {
			method: "POST",
			url: "http://api:8000/notifications",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $json.period + ':anomaly-alert:' + $json.contributor_id, recipient_id: $json.contributor_id, kind: 'anomaly_alert', detail: $json.detail } }}",
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
			event_id: "2026-08:anomaly-alert:c1",
			recipient_id: "c1",
			kind: "anomaly_alert",
			message:
				"정산 이상 징후가 감지되었습니다: [수익 급감] 이전 주기 대비 사용량은 유지되는데 수익이 급감했습니다. 정산 내역을 확인해 주세요.",
			replayed: false,
		},
	],
});

export default workflow(
	"phase-2-settlement-anomaly-monitor",
	"Phase 2 - Monitor Settlement Anomalies",
)
	.add(monitorSchedule)
	.to(getSettlements)
	.to(detectAnomalies)
	.to(notifyContributor);
