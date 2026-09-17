import { expr, ifElse, node, trigger, workflow } from "@n8n/workflow-sdk";

const receiveReviewDecision = trigger({
	type: "n8n-nodes-base.webhook",
	version: 2.1,
	config: {
		name: "Receive Review Decision",
		parameters: {
			httpMethod: "POST",
			path: "phase-1/review-decisions",
			authentication: "none",
			responseMode: "lastNode",
			responseData: "firstEntryJson",
		},
	},
	output: [
		{
			body: {
				event_id: "review-decision-1",
				submission_id: "submission-1",
				decision: "rejected",
				reasons: ["visual_quality"],
			},
		},
	],
});

const getSubmission = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Get Submission",
		parameters: {
			method: "GET",
			url: expr(
				"{{ 'http://api:8000/submissions/' + $('Receive Review Decision').item.json.body.submission_id }}",
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
			submission_id: "submission-1",
			contributor_id: "contributor-1",
		},
	],
});

const recordReviewDecision = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Record Review Decision",
		parameters: {
			method: "POST",
			url: "http://api:8000/review-decisions",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr("{{ $('Receive Review Decision').item.json.body }}"),
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
			event_id: "review-decision-1",
			submission_id: "submission-1",
			decision: "rejected",
			reasons: [
				{
					rule: "visual_quality",
					name: "시각 품질 기준",
					guidance:
						"깨짐, 정렬과 마감 상태를 확인해 품질 문제를 수정해 주세요.",
				},
			],
			replayed: false,
		},
	],
});

const routeRejectedDecision = ifElse({
	version: 2.3,
	config: {
		name: "Decision Is Rejected",
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
						leftValue: expr("{{ $json.decision }}"),
						rightValue: "rejected",
						operator: {
							type: "string",
							operation: "equals",
						},
					},
				],
			},
			looseTypeValidation: false,
		},
	},
	output: [{ decision: "rejected" }],
});

const notifyContributor = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Notify Review Rejection",
		parameters: {
			method: "POST",
			url: "http://api:8000/notifications",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $('Record Review Decision').item.json.event_id + ':rejection-notification', recipient_id: $('Get Submission').item.json.contributor_id, kind: 'rejection', reference_event_id: $('Record Review Decision').item.json.event_id } }}",
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
			event_id: "review-decision-1:rejection-notification",
			recipient_id: "contributor-1",
			kind: "rejection",
			message:
				"반려 사유: [시각 품질 기준] 깨짐, 정렬과 마감 상태를 확인해 품질 문제를 수정해 주세요.",
			replayed: false,
		},
	],
});

export default workflow(
	"phase-1-review-decision-notification",
	"Phase 1 - Notify Review Decision",
)
	.add(receiveReviewDecision)
	.to(getSubmission)
	.to(recordReviewDecision)
	.to(routeRejectedDecision.onTrue(notifyContributor));
