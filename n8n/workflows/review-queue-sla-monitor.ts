import { expr, ifElse, node, trigger, workflow } from "@n8n/workflow-sdk";

const monitorSchedule = trigger({
	type: "n8n-nodes-base.scheduleTrigger",
	version: 1.4,
	config: {
		name: "Daily Review Queue Check",
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

const checkSla = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Check Review Queue SLA",
		parameters: {
			method: "POST",
			url: "http://api:8000/review-queue/sla-checks",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: 'review-sla:' + $today.toISODate(), checked_at: $today.set({ hour: 9 }).toISO(), max_wait_days: 10, max_queue_size: 20 } }}",
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
			event_id: "review-sla:2026-09-17",
			longest_wait_days: 11,
			queue_size: 21,
			breaches: [
				{
					metric: "longest_wait_days",
					actual: 11,
					threshold: 10,
				},
			],
			replayed: false,
		},
	],
});

const hasSlaBreach = ifElse({
	version: 2.3,
	config: {
		name: "SLA Threshold Exceeded",
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
						leftValue: expr("{{ $json.breaches.length }}"),
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
	output: [{ breaches: [{ metric: "longest_wait_days" }] }],
});

const notifyOperator = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Notify Review Operations",
		parameters: {
			method: "POST",
			url: "http://api:8000/notifications",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $('Check Review Queue SLA').item.json.event_id + ':operator-notification', recipient_id: 'review-operations', kind: 'operator_alert', reference_event_id: $('Check Review Queue SLA').item.json.event_id } }}",
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
			event_id: "review-sla:2026-09-17:operator-notification",
			recipient_id: "review-operations",
			kind: "operator_alert",
			message: "심사 대기열 SLA 임계값을 초과했습니다: longest_wait_days",
			replayed: false,
		},
	],
});

export default workflow(
	"phase-1-review-queue-sla-monitor",
	"Phase 1 - Monitor Review Queue SLA",
)
	.add(monitorSchedule)
	.to(checkSla)
	.to(hasSlaBreach.onTrue(notifyOperator));
