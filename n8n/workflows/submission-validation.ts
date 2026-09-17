import { expr, ifElse, node, trigger, workflow } from "@n8n/workflow-sdk";

const receiveSubmission = trigger({
	type: "n8n-nodes-base.webhook",
	version: 2.1,
	config: {
		name: "Receive Submission",
		parameters: {
			httpMethod: "POST",
			path: "phase-1/submissions",
			authentication: "none",
			responseMode: "lastNode",
			responseData: "firstEntryJson",
		},
	},
	output: [
		{
			body: {
				event_id: "submission-event-1",
				submission_id: "submission-1",
				contributor_id: "contributor-1",
				content_type: "svg",
				format: "svg",
				width: 1000,
				height: 1000,
				file_size_bytes: 102400,
				svg_attributes: {},
				element_count: 100,
				whitespace_ratio: 0.2,
				submitted_at: "2026-09-17T00:00:00Z",
			},
		},
	],
});

const createSubmission = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Create Submission",
		parameters: {
			method: "POST",
			url: "http://api:8000/submissions",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr("{{ $('Receive Submission').item.json.body }}"),
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
			event_id: "submission-event-1",
			submission: {
				submission_id: "submission-1",
				contributor_id: "contributor-1",
			},
			replayed: false,
		},
	],
});

const validateSubmission = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Validate Submission",
		parameters: {
			method: "POST",
			url: "http://api:8000/submission-validations",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $('Receive Submission').item.json.body.event_id + ':validation', submission_id: $('Receive Submission').item.json.body.submission_id } }}",
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
			event_id: "submission-event-1:validation",
			submission_id: "submission-1",
			valid: true,
			violations: [],
			replayed: false,
		},
	],
});

const routeValidation = ifElse({
	version: 2.3,
	config: {
		name: "Passed Validation",
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
						leftValue: expr("{{ $json.valid }}"),
						rightValue: "",
						operator: {
							type: "boolean",
							operation: "true",
							singleValue: true,
						},
					},
				],
			},
			looseTypeValidation: false,
		},
	},
	output: [{ valid: true }],
});

const enqueueSubmission = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Enqueue Submission",
		parameters: {
			method: "POST",
			url: "http://api:8000/review-queue",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $('Receive Submission').item.json.body.event_id + ':enqueue', submission_id: $('Receive Submission').item.json.body.submission_id, validation_event_id: $('Validate Submission').item.json.event_id } }}",
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
			event_id: "submission-event-1:enqueue",
			submission_id: "submission-1",
			contributor_id: "contributor-1",
			replayed: false,
		},
	],
});

const notifyRejection = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Notify Automatic Rejection",
		parameters: {
			method: "POST",
			url: "http://api:8000/notifications",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $('Receive Submission').item.json.body.event_id + ':rejection-notification', recipient_id: $('Receive Submission').item.json.body.contributor_id, kind: 'rejection', reference_event_id: $('Validate Submission').item.json.event_id } }}",
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
			event_id: "submission-event-1:rejection-notification",
			recipient_id: "contributor-1",
			kind: "rejection",
			message:
				"반려 사유: [요소 개수] 디자인 요소를 1,000개 이하로 줄여 주세요.",
			replayed: false,
		},
	],
});

export default workflow(
	"phase-1-submission-validation",
	"Phase 1 - Validate Submission",
)
	.add(receiveSubmission)
	.to(createSubmission)
	.to(validateSubmission)
	.to(routeValidation.onTrue(enqueueSubmission).onFalse(notifyRejection));
