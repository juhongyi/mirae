import { expr, ifElse, node, trigger, workflow } from "@n8n/workflow-sdk";

const monitorSchedule = trigger({
	type: "n8n-nodes-base.scheduleTrigger",
	version: 1.4,
	config: {
		name: "Daily Settlement Anomaly Check",
		parameters: {
			rule: {
				interval: [
					{
						field: "days",
						daysInterval: 1,
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

const checkAnomalies = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Check Settlement Anomalies",
		parameters: {
			method: "POST",
			url: "http://api:8000/settlement-anomaly-checks",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: 'settlement-anomaly:' + $today.toFormat('yyyy-MM'), period: $today.toFormat('yyyy-MM'), previous_period: $today.minus(1, 'month').toFormat('yyyy-MM') } }}",
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
			event_id: "settlement-anomaly:2026-09",
			period: "2026-09",
			anomalies: {
				c1: [
					{
						rule: "zero_revenue",
						name: "0원 급변",
						guidance: "0원으로 집계되었습니다.",
					},
				],
			},
			replayed: false,
		},
	],
});

const buildAnomalyAlerts = node({
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Build Anomaly Alerts",
		parameters: {
			mode: "runOnceForAllItems",
			language: "javaScript",
			jsCode:
				"const check = $input.all()[0].json;\nconst anomalies = check.anomalies || {};\nconst result = [];\nfor (const contributorId of Object.keys(anomalies)) {\n  result.push({ json: { event_id: check.event_id, contributor_id: contributorId, anomalies: anomalies[contributorId] } });\n}\nreturn result;",
		},
	},
	output: [
		{
			event_id: "settlement-anomaly:2026-09",
			contributor_id: "c1",
			anomalies: [{ rule: "zero_revenue", name: "0원 급변" }],
		},
	],
});

const hasAnomalies = ifElse({
	version: 2.3,
	config: {
		name: "Has Anomalies",
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
						leftValue: expr("{{ $json.anomalies.length }}"),
						rightValue: 0,
						operator: {
							type: "number",
							operation: "gt",
						},
					},
				],
			},
			looseTypeValidation: false,
		},
	},
	output: [{ contributor_id: "c1" }],
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
				"{{ { event_id: $json.event_id + ':anomaly-alert:' + $json.contributor_id, recipient_id: $json.contributor_id, kind: 'anomaly_alert', reference_event_id: $json.event_id } }}",
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
			event_id: "settlement-anomaly:2026-09:anomaly-alert:c1",
			recipient_id: "c1",
			kind: "anomaly_alert",
			message:
				"정산 이상 징후가 감지되었습니다: [0원 급변] 0원으로 집계되었습니다.",
			replayed: false,
		},
	],
});

export default workflow(
	"phase-2-settlement-anomaly-monitor",
	"Phase 2 - Monitor Settlement Anomalies",
)
	.add(monitorSchedule)
	.to(checkAnomalies)
	.to(buildAnomalyAlerts)
	.to(hasAnomalies.onTrue(notifyContributor));
