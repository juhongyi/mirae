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

const getReviewQueue = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Get Review Queue",
		parameters: {
			method: "GET",
			url: "http://api:8000/review-queue",
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
					event_id: "submission-event-1:enqueue",
					submission_id: "submission-1",
					contributor_id: "contributor-1",
					submitted_at: "2026-09-01T09:00:00.000Z",
				},
			],
		},
	],
});

const calculateSla = node({
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Calculate SLA Breaches",
		parameters: {
			mode: "runOnceForAllItems",
			jsCode: `const input = $input.first().json;
const date = new Date().toISOString().slice(0, 10);
const checkedAt = date + "T09:00:00.000Z";
const checkedAtMs = Date.parse(checkedAt);
const waits = (input.items || []).map((item) => Math.max(0, (checkedAtMs - Date.parse(item.submitted_at)) / 86400000));
const longestWaitDays = waits.length === 0 ? 0 : Math.max(...waits);
const queueSize = (input.items || []).length;
const breaches = [];
if (longestWaitDays > 10) breaches.push({ metric: "longest_wait_days", actual: longestWaitDays, threshold: 10 });
if (queueSize > 20) breaches.push({ metric: "queue_size", actual: queueSize, threshold: 20 });
const metrics = breaches.map((breach) => breach.metric).join(", ");
return [{ json: {
  event_id: "review-sla:" + date,
  checked_at: checkedAt,
  longest_wait_days: longestWaitDays,
  queue_size: queueSize,
  breaches,
  message: metrics ? "심사 대기열 SLA 임계값을 초과했습니다: " + metrics : "",
} }];`,
		},
	},
	output: [
		{
			event_id: "review-sla:2026-09-18",
			checked_at: "2026-09-18T09:00:00.000Z",
			longest_wait_days: 17,
			queue_size: 1,
			breaches: [{ metric: "longest_wait_days", actual: 17, threshold: 10 }],
			message: "심사 대기열 SLA 임계값을 초과했습니다: longest_wait_days",
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
				"{{ { event_id: $('Calculate SLA Breaches').item.json.event_id + ':operator-notification', recipient_id: 'review-operations', kind: 'operator_alert', reference_event_id: $('Calculate SLA Breaches').item.json.event_id, message: $('Calculate SLA Breaches').item.json.message } }}",
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
			event_id: "review-sla:2026-09-18:operator-notification",
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
	.to(getReviewQueue)
	.to(calculateSla)
	.to(hasSlaBreach.onTrue(notifyOperator));
