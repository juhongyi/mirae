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
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Evaluate Submission Rules",
		parameters: {
			mode: "runOnceForAllItems",
			jsCode: `const submission = $("Receive Submission").first().json.body;
const reasons = {
  file_specification: { rule: "file_specification", name: "파일 규격", guidance: "지원 형식, 크기와 해상도 기준에 맞게 파일을 수정해 주세요." },
  forbidden_attribute: { rule: "forbidden_attribute", name: "금지 속성", guidance: "SVG의 evenodd 채우기 규칙과 stroke 속성을 패스로 변환해 주세요." },
  element_count: { rule: "element_count", name: "요소 개수", guidance: "디자인 요소를 1,000개 이하로 줄여 주세요." },
  whitespace_ratio: { rule: "whitespace_ratio", name: "여백 비율", guidance: "피사체가 대지의 절반 이상을 차지하도록 여백을 줄여 주세요." },
};
const contentType = submission.content_type;
const rawFormat = submission.format.toLowerCase();
const format = rawFormat.startsWith(".") ? rawFormat.slice(1) : rawFormat;
const allowedFormats = contentType === "svg" ? ["svg"] : ["png", "jpg", "jpeg"];
const maxFileBytes = contentType === "svg" ? 150 * 1024 : 10 * 1024 * 1024;
const violations = [];
if (!allowedFormats.includes(format) || submission.file_size_bytes > maxFileBytes || submission.width < 100 || submission.width > 10000 || submission.height < 100 || submission.height > 10000) {
  violations.push(reasons.file_specification);
}
const attributes = Object.fromEntries(Object.entries(submission.svg_attributes || {}).map(([key, value]) => [key.toLowerCase(), String(value).toLowerCase()]));
if (contentType === "svg" && (attributes["fill-rule"] === "evenodd" || Object.hasOwn(attributes, "stroke"))) {
  violations.push(reasons.forbidden_attribute);
}
if (contentType === "svg" && submission.element_count > 1000) {
  violations.push(reasons.element_count);
}
if (submission.whitespace_ratio > 0.5) {
  violations.push(reasons.whitespace_ratio);
}
return [{ json: { event_id: submission.event_id + ":validation", submission_id: submission.submission_id, valid: violations.length === 0, violations } }];`,
		},
	},
	output: [
		{
			event_id: "submission-event-1:validation",
			submission_id: "submission-1",
			valid: true,
			violations: [],
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
				"{{ { event_id: $('Receive Submission').item.json.body.event_id + ':enqueue', submission_id: $('Receive Submission').item.json.body.submission_id } }}",
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

const buildRejectionMessage = node({
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Build Automatic Rejection Message",
		parameters: {
			mode: "runOnceForAllItems",
			jsCode: `return $input.all().map((item) => ({
  json: {
    ...item.json,
    message: "반려 사유: " + item.json.violations.map((violation) => "[" + violation.name + "] " + violation.guidance).join(" "),
  },
}));`,
		},
	},
	output: [
		{
			event_id: "submission-event-1:validation",
			submission_id: "submission-1",
			valid: false,
			violations: [
				{
					rule: "element_count",
					name: "요소 개수",
					guidance: "디자인 요소를 1,000개 이하로 줄여 주세요.",
				},
			],
			message:
				"반려 사유: [요소 개수] 디자인 요소를 1,000개 이하로 줄여 주세요.",
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
				"{{ { event_id: $('Receive Submission').item.json.body.event_id + ':rejection-notification', recipient_id: $('Receive Submission').item.json.body.contributor_id, kind: 'rejection', reference_event_id: $('Evaluate Submission Rules').item.json.event_id, message: $json.message } }}",
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
	.to(
		routeValidation
			.onTrue(enqueueSubmission)
			.onFalse(buildRejectionMessage.to(notifyRejection)),
	);
