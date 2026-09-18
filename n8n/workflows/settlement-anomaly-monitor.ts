import { expr, ifElse, node, trigger, workflow } from "@n8n/workflow-sdk";

const monthlySchedule = trigger({
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
						triggerAtDayOfMonth: 1,
						triggerAtHour: 2,
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
		name: "Get Raw Settlements",
		parameters: {
			method: "GET",
			url: "http://api:8000/settlements",
			authentication: "none",
			options: {
				timeout: 10000,
				response: { response: { responseFormat: "json" } },
			},
		},
	},
	output: [{ items: [] }],
});

const evaluateAnomalies = node({
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Evaluate Settlement Anomalies",
		parameters: {
			mode: "runOnceForAllItems",
			jsCode: `const rows = $input.all().flatMap((item) => Array.isArray(item.json.items) ? item.json.items : [item.json]);
const now = new Date();
const currentDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const previousDate = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth() - 1, 1));
const formatPeriod = (date) => date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
const period = formatPeriod(currentDate);
const previousPeriod = formatPeriod(previousDate);
const settlements = new Map();

rows
	.filter((row) => row && (row.period === period || row.period === previousPeriod) && row.contributor_id)
	.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
	.forEach((row) => {
		const key = row.contributor_id + ":" + row.period;
		if (!settlements.has(key)) settlements.set(key, row);
	});

const affected = [];
const contributors = [...new Set([...settlements.values()].filter((row) => row.period === period).map((row) => row.contributor_id))].sort();
for (const contributorId of contributors) {
	const current = settlements.get(contributorId + ":" + period);
	const previous = settlements.get(contributorId + ":" + previousPeriod);
	if (!previous) continue;

	const anomalies = [];
	const previousRevenue = Number(previous.revenue);
	const currentRevenue = Number(current.revenue);
	const previousUsage = Number(previous.usage_count);
	const currentUsage = Number(current.usage_count);
	if (previousRevenue > 0 && currentRevenue > 0 && previousUsage > 0 && currentUsage / previousUsage >= 0.8 && currentRevenue / previousRevenue <= 0.7) {
			anomalies.push({ rule: "revenue_drop", message: "사용량은 이전 주기의 80% 이상이지만 수익은 70% 이하로 감소했습니다." });
	}

	const amounts = (items) => {
		const totals = new Map();
		for (const item of Array.isArray(items) ? items : []) {
			if (!item.content_id) continue;
			const amount = Number(item.amount);
			totals.set(item.content_id, (totals.get(item.content_id) || 0) + (Number.isFinite(amount) ? amount : 0));
		}
		return totals;
	};
	const previousAmounts = amounts(previous.usage_items);
	const currentAmounts = amounts(current.usage_items);
	for (const contentId of [...previousAmounts.keys()].sort()) {
		if (previousAmounts.get(contentId) > 0 && (currentAmounts.get(contentId) || 0) === 0) {
			anomalies.push({ rule: "content_zero_revenue", content_id: contentId, message: "콘텐츠 '" + contentId + "'의 금액이 양수에서 0원 또는 미집계 상태로 바뀌었습니다." });
		}
	}

	const previousStatuses = previous.content_statuses || {};
	const currentStatuses = current.content_statuses || {};
	for (const contentId of Object.keys(currentStatuses).sort()) {
		if (previousStatuses[contentId] === "published" && currentStatuses[contentId] === "unpublished") {
			anomalies.push({ rule: "content_unpublished", content_id: contentId, message: "콘텐츠 '" + contentId + "'가 공개에서 비공개 상태로 바뀌었습니다." });
		}
	}

	const unique = [...new Map(anomalies.map((anomaly) => [anomaly.rule + ":" + (anomaly.content_id || ""), anomaly])).values()];
	if (unique.length > 0) {
		affected.push({
			event_id: "settlement-anomaly:" + period + ":" + contributorId,
			contributor_id: contributorId,
			period,
			previous_period: previousPeriod,
			anomalies: unique,
			message: period + " 정산에서 확인이 필요한 이상 징후가 감지되었습니다: " + unique.map((anomaly) => anomaly.message).join(" "),
		});
	}
}

return [{ json: { items: affected } }];`,
		},
	},
	output: [{ items: [] }],
});

const hasAnomalies = ifElse({
	version: 2.3,
	config: {
		name: "Has Settlement Anomalies",
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

const splitAnomalies = node({
	type: "n8n-nodes-base.splitOut",
	version: 1,
	config: {
		name: "Split Affected Contributors",
		parameters: {
			fieldToSplitOut: "items",
			options: {},
		},
	},
	output: [{ event_id: "settlement-anomaly:2026-09:contributor-1" }],
});

const notifyContributor = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Send Anomaly Signal",
		parameters: {
			method: "POST",
			url: "http://api:8000/notifications",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $json.event_id + ':notification', recipient_id: $json.contributor_id, kind: 'anomaly_alert', reference_event_id: $json.event_id, message: $json.message } }}",
			),
			options: {
				timeout: 10000,
				response: { response: { responseFormat: "json" } },
			},
		},
	},
	output: [
		{ event_id: "settlement-anomaly:2026-09:contributor-1:notification" },
	],
});

export default workflow(
	"phase-2-settlement-anomaly-monitor",
	"Phase 2 - Monitor Settlement Anomalies",
)
	.add(monthlySchedule)
	.to(getSettlements)
	.to(evaluateAnomalies)
	.to(hasAnomalies.onTrue(splitAnomalies.to(notifyContributor)));
