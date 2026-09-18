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
			reasons: ["visual_quality"],
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

const buildRejectionMessage = node({
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Build Review Rejection Message",
		parameters: {
			mode: "runOnceForAllItems",
			jsCode: `const reasons = {
  file_specification: ["파일 규격", "지원 형식, 크기와 해상도 기준에 맞게 파일을 수정해 주세요."],
  forbidden_attribute: ["금지 속성", "SVG의 evenodd 채우기 규칙과 stroke 속성을 패스로 변환해 주세요."],
  element_count: ["요소 개수", "디자인 요소를 1,000개 이하로 줄여 주세요."],
  whitespace_ratio: ["여백 비율", "피사체가 대지의 절반 이상을 차지하도록 여백을 줄여 주세요."],
  copyright_risk: ["저작권 위험", "사용 권리를 확인하고 필요한 권리 증빙을 제출해 주세요."],
  visual_quality: ["시각 품질 기준", "깨짐, 정렬과 마감 상태를 확인해 품질 문제를 수정해 주세요."],
};
return $input.all().map((item) => {
  const details = item.json.reasons.map((code) => "[" + reasons[code][0] + "] " + reasons[code][1]).join(" ");
  return { json: { ...item.json, message: "반려 사유: " + details } };
});`,
		},
	},
	output: [
		{
			event_id: "review-decision-1",
			submission_id: "submission-1",
			decision: "rejected",
			reasons: ["visual_quality"],
			message:
				"반려 사유: [시각 품질 기준] 깨짐, 정렬과 마감 상태를 확인해 품질 문제를 수정해 주세요.",
			replayed: false,
		},
	],
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
				"{{ { event_id: $('Record Review Decision').item.json.event_id + ':rejection-notification', recipient_id: $('Get Submission').item.json.contributor_id, kind: 'rejection', reference_event_id: $('Record Review Decision').item.json.event_id, message: $json.message } }}",
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
	.to(
		routeRejectedDecision.onTrue(buildRejectionMessage.to(notifyContributor)),
	);
