import { expr, ifElse, node, trigger, workflow } from "@n8n/workflow-sdk";

const receiveSubmission = trigger({
	type: "n8n-nodes-base.webhook",
	version: 2.1,
	config: {
		name: "Receive SVG Submission",
		parameters: {
			httpMethod: "POST",
			path: "phase-3/svg-submissions",
			authentication: "none",
			responseMode: "lastNode",
			responseData: "firstEntryJson",
		},
	},
	output: [
		{
			body: {
				event_id: "svg-submission-event-1",
				submission_id: "submission-svg-1",
				contributor_id: "contributor-1",
				content_type: "svg",
				format: "svg",
				width: 1000,
				height: 1000,
				file_size_bytes: 102400,
				svg_attributes: { "fill-rule": "evenodd" },
				element_count: 10,
				whitespace_ratio: 0.2,
				submitted_at: "2026-09-17T00:00:00Z",
				svg_content:
					"M 0 0 L 100 0 L 100 100 L 0 100 Z M 10 10 L 90 10 L 90 90 L 10 90 Z",
			},
		},
	],
});

const convertSvg = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Convert SVG",
		parameters: {
			method: "POST",
			url: "http://api:8000/svg-conversions",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $('Receive SVG Submission').item.json.body.event_id + ':conversion', submission_id: $('Receive SVG Submission').item.json.body.submission_id, svg_content: $('Receive SVG Submission').item.json.body.svg_content } }}",
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
			event_id: "svg-submission-event-1:conversion",
			submission_id: "submission-svg-1",
			success: true,
			converted_content:
				"M 0.0,0.0 L 100.0,0.0 L 100.0,100.0 L 0.0,100.0 L 0.0,0.0 M 10.0,10.0 L 10.0,90.0 L 90.0,90.0 L 90.0,10.0 L 10.0,10.0",
			error: null,
			replayed: false,
		},
	],
});

const routeConversion = ifElse({
	version: 2.3,
	config: {
		name: "Conversion Succeeded",
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
						leftValue: expr("{{ $json.success }}"),
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
	output: [{ success: true }],
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
			jsonBody: expr(
				"{{ { event_id: $('Receive SVG Submission').item.json.body.event_id + ':submission', submission_id: $('Receive SVG Submission').item.json.body.submission_id, contributor_id: $('Receive SVG Submission').item.json.body.contributor_id, content_type: $('Receive SVG Submission').item.json.body.content_type, format: $('Receive SVG Submission').item.json.body.format, width: $('Receive SVG Submission').item.json.body.width, height: $('Receive SVG Submission').item.json.body.height, file_size_bytes: $('Receive SVG Submission').item.json.body.file_size_bytes, svg_attributes: {}, element_count: $('Receive SVG Submission').item.json.body.element_count, whitespace_ratio: $('Receive SVG Submission').item.json.body.whitespace_ratio, submitted_at: $('Receive SVG Submission').item.json.body.submitted_at } }}",
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
			event_id: "svg-submission-event-1:submission",
			submission: {
				submission_id: "submission-svg-1",
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
				"{{ { event_id: $('Receive SVG Submission').item.json.body.event_id + ':validation', submission_id: $('Receive SVG Submission').item.json.body.submission_id } }}",
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
			event_id: "svg-submission-event-1:validation",
			submission_id: "submission-svg-1",
			valid: true,
			violations: [],
			replayed: false,
		},
	],
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
				"{{ { event_id: $('Receive SVG Submission').item.json.body.event_id + ':enqueue', submission_id: $('Receive SVG Submission').item.json.body.submission_id, validation_event_id: $('Validate Submission').item.json.event_id } }}",
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
			event_id: "svg-submission-event-1:enqueue",
			submission_id: "submission-svg-1",
			contributor_id: "contributor-1",
			replayed: false,
		},
	],
});

const notifyConversionFailure = node({
	type: "n8n-nodes-base.httpRequest",
	version: 4.5,
	config: {
		name: "Notify Conversion Failure",
		parameters: {
			method: "POST",
			url: "http://api:8000/notifications",
			authentication: "none",
			sendBody: true,
			contentType: "json",
			specifyBody: "json",
			jsonBody: expr(
				"{{ { event_id: $('Receive SVG Submission').item.json.body.event_id + ':conversion-failure', recipient_id: $('Receive SVG Submission').item.json.body.contributor_id, kind: 'conversion_failure', reference_event_id: $('Convert SVG').item.json.event_id } }}",
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
			event_id: "svg-submission-event-1:conversion-failure",
			recipient_id: "contributor-1",
			kind: "conversion_failure",
			message:
				"SVG 변환에 실패했습니다: 변환 전후 렌더링이 일치하지 않아 사람 검토가 필요합니다.",
			replayed: false,
		},
	],
});

export default workflow(
	"phase-3-svg-conversion",
	"Phase 3 - Convert SVG Submissions",
)
	.add(receiveSubmission)
	.to(convertSvg)
	.to(
		routeConversion
			.onTrue(createSubmission.to(validateSubmission.to(enqueueSubmission)))
			.onFalse(notifyConversionFailure),
	);
