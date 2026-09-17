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

const conversionCode = `
const input = $input.first().json.body ?? $input.first().json;

function parsePath(data) {
  const tokenPattern = /[a-zA-Z]|[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?/g;
  const tokens = data.match(tokenPattern) || [];
  const residue = data.replace(tokenPattern, "").replace(/[\\s,]/g, "");
  if (!tokens.length || residue) throw new Error("SVG 경로 문법이 올바르지 않습니다.");

  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const paths = [];
  let current;
  let command;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastCubic;
  let lastQuadratic;
  let index = 0;

  const isCommand = (value) => /^[a-zA-Z]$/.test(value);
  const point = (values, offset, relative) => ({
    x: values[offset] + (relative ? x : 0),
    y: values[offset + 1] + (relative ? y : 0),
  });

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    if (!command || counts[command.toUpperCase()] === undefined) {
      throw new Error("지원하지 않는 SVG 경로 명령입니다.");
    }

    const upper = command.toUpperCase();
    const relative = command !== upper;
    if (upper === "Z") {
      if (!current) throw new Error("이동 명령 없이 경로를 닫을 수 없습니다.");
      current.closed = true;
      x = startX;
      y = startY;
      lastCubic = undefined;
      lastQuadratic = undefined;
      command = undefined;
      continue;
    }

    const count = counts[upper];
    if (index + count > tokens.length || tokens.slice(index, index + count).some(isCommand)) {
      throw new Error("SVG 경로 명령의 좌표가 부족합니다.");
    }
    const values = tokens.slice(index, index + count).map(Number);
    index += count;
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error("SVG 경로 좌표가 올바르지 않습니다.");
    }

    if (upper === "M") {
      const end = point(values, 0, relative);
      x = end.x;
      y = end.y;
      startX = x;
      startY = y;
      current = { start: { ...end }, segments: [], closed: false };
      paths.push(current);
      command = relative ? "l" : "L";
      lastCubic = undefined;
      lastQuadratic = undefined;
      continue;
    }
    if (!current) throw new Error("SVG 경로는 이동 명령으로 시작해야 합니다.");

    const start = { x, y };
    let segment;
    if (upper === "L") {
      segment = { type: "L", start, end: point(values, 0, relative) };
    } else if (upper === "H") {
      segment = { type: "L", start, end: { x: values[0] + (relative ? x : 0), y } };
    } else if (upper === "V") {
      segment = { type: "L", start, end: { x, y: values[0] + (relative ? y : 0) } };
    } else if (upper === "C") {
      segment = {
        type: "C",
        start,
        c1: point(values, 0, relative),
        c2: point(values, 2, relative),
        end: point(values, 4, relative),
      };
    } else if (upper === "S") {
      const c1 = lastCubic
        ? { x: 2 * x - lastCubic.x, y: 2 * y - lastCubic.y }
        : { x, y };
      segment = {
        type: "C",
        start,
        c1,
        c2: point(values, 0, relative),
        end: point(values, 2, relative),
      };
    } else if (upper === "Q") {
      segment = {
        type: "Q",
        start,
        c: point(values, 0, relative),
        end: point(values, 2, relative),
      };
    } else if (upper === "T") {
      const c = lastQuadratic
        ? { x: 2 * x - lastQuadratic.x, y: 2 * y - lastQuadratic.y }
        : { x, y };
      segment = { type: "Q", start, c, end: point(values, 0, relative) };
    } else if (upper === "A") {
      if (values[0] < 0 || values[1] < 0 || ![0, 1].includes(values[3]) || ![0, 1].includes(values[4])) {
        throw new Error("SVG 호 명령의 매개변수가 올바르지 않습니다.");
      }
      segment = {
        type: "A",
        start,
        rx: values[0],
        ry: values[1],
        rotation: values[2],
        large: values[3],
        sweep: values[4],
        end: point(values, 5, relative),
      };
    }

    current.segments.push(segment);
    x = segment.end.x;
    y = segment.end.y;
    lastCubic = segment.type === "C" ? segment.c2 : undefined;
    lastQuadratic = segment.type === "Q" ? segment.c : undefined;
  }

  return paths;
}

function arcPoints(segment) {
  if (!segment.rx || !segment.ry || (segment.start.x === segment.end.x && segment.start.y === segment.end.y)) {
    return [segment.end];
  }
  const phi = (segment.rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (segment.start.x - segment.end.x) / 2;
  const dy = (segment.start.y - segment.end.y) / 2;
  const xp = cosPhi * dx + sinPhi * dy;
  const yp = -sinPhi * dx + cosPhi * dy;
  let rx = Math.abs(segment.rx);
  let ry = Math.abs(segment.ry);
  const scale = xp * xp / (rx * rx) + yp * yp / (ry * ry);
  if (scale > 1) {
    const factor = Math.sqrt(scale);
    rx *= factor;
    ry *= factor;
  }
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp);
  const denominator = rx * rx * yp * yp + ry * ry * xp * xp;
  const sign = segment.large === segment.sweep ? -1 : 1;
  const factor = denominator ? sign * Math.sqrt(numerator / denominator) : 0;
  const cxp = factor * (rx * yp) / ry;
  const cyp = factor * (-ry * xp) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (segment.start.x + segment.end.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (segment.start.y + segment.end.y) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (xp - cxp) / rx;
  const uy = (yp - cyp) / ry;
  const vx = (-xp - cxp) / rx;
  const vy = (-yp - cyp) / ry;
  const startAngle = angle(1, 0, ux, uy);
  let delta = angle(ux, uy, vx, vy);
  if (!segment.sweep && delta > 0) delta -= 2 * Math.PI;
  if (segment.sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 16)));
  return Array.from({ length: steps }, (_, offset) => {
    const theta = startAngle + delta * (offset + 1) / steps;
    return {
      x: cx + cosPhi * rx * Math.cos(theta) - sinPhi * ry * Math.sin(theta),
      y: cy + sinPhi * rx * Math.cos(theta) + cosPhi * ry * Math.sin(theta),
    };
  });
}

function flatten(path) {
  const points = [{ ...path.start }];
  for (const segment of path.segments) {
    if (segment.type === "L") {
      points.push({ ...segment.end });
    } else if (segment.type === "A") {
      points.push(...arcPoints(segment));
    } else {
      for (let step = 1; step <= 16; step++) {
        const t = step / 16;
        const u = 1 - t;
        if (segment.type === "C") {
          points.push({
            x: u ** 3 * segment.start.x + 3 * u * u * t * segment.c1.x + 3 * u * t * t * segment.c2.x + t ** 3 * segment.end.x,
            y: u ** 3 * segment.start.y + 3 * u * u * t * segment.c1.y + 3 * u * t * t * segment.c2.y + t ** 3 * segment.end.y,
          });
        } else {
          points.push({
            x: u * u * segment.start.x + 2 * u * t * segment.c.x + t * t * segment.end.x,
            y: u * u * segment.start.y + 2 * u * t * segment.c.y + t * t * segment.end.y,
          });
        }
      }
    }
  }
  return points;
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    area += points[i].x * next.y - next.x * points[i].y;
  }
  return area / 2;
}

function contains(points, target) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a.y > target.y) !== (b.y > target.y) && target.x < (b.x - a.x) * (target.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function winding(points, target) {
  let value = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = (b.x - a.x) * (target.y - a.y) - (target.x - a.x) * (b.y - a.y);
    if (a.y <= target.y && b.y > target.y && cross > 0) value++;
    if (a.y > target.y && b.y <= target.y && cross < 0) value--;
  }
  return value;
}

function reversePath(path) {
  const end = path.segments.length ? path.segments[path.segments.length - 1].end : path.start;
  const segments = [...path.segments].reverse().map((segment) => {
    if (segment.type === "C") return { ...segment, start: segment.end, c1: segment.c2, c2: segment.c1, end: segment.start };
    if (segment.type === "Q") return { ...segment, start: segment.end, end: segment.start };
    if (segment.type === "A") return { ...segment, start: segment.end, end: segment.start, sweep: segment.sweep ? 0 : 1 };
    return { ...segment, start: segment.end, end: segment.start };
  });
  return { start: { ...end }, segments, closed: path.closed };
}

function format(value) {
  return Number(value.toFixed(6)).toString();
}

function serialize(paths) {
  return paths.map((path) => {
    const commands = ["M " + format(path.start.x) + " " + format(path.start.y)];
    for (const segment of path.segments) {
      if (segment.type === "L") commands.push("L " + format(segment.end.x) + " " + format(segment.end.y));
      if (segment.type === "C") commands.push("C " + format(segment.c1.x) + " " + format(segment.c1.y) + " " + format(segment.c2.x) + " " + format(segment.c2.y) + " " + format(segment.end.x) + " " + format(segment.end.y));
      if (segment.type === "Q") commands.push("Q " + format(segment.c.x) + " " + format(segment.c.y) + " " + format(segment.end.x) + " " + format(segment.end.y));
      if (segment.type === "A") commands.push("A " + format(segment.rx) + " " + format(segment.ry) + " " + format(segment.rotation) + " " + segment.large + " " + segment.sweep + " " + format(segment.end.x) + " " + format(segment.end.y));
    }
    if (path.closed) commands.push("Z");
    return commands.join(" ");
  }).join(" ");
}

function convert(data) {
  const original = parsePath(data);
  const originalPolygons = original.map(flatten);
  if (originalPolygons.some((points) => points.length < 3 || Math.abs(signedArea(points)) < 1e-9)) {
    throw new Error("닫힌 면적을 가진 SVG 경로만 변환할 수 있습니다.");
  }
  const converted = original.map((path, index) => {
    const sample = originalPolygons[index][0];
    const depth = originalPolygons.filter((points, other) => other !== index && contains(points, sample)).length;
    const desiredSign = depth % 2 === 0 ? 1 : -1;
    return Math.sign(signedArea(originalPolygons[index])) === desiredSign ? path : reversePath(path);
  });
  const convertedContent = serialize(converted);
  const convertedPolygons = parsePath(convertedContent).map(flatten);
  const points = originalPolygons.flat();
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  let mismatches = 0;
  for (let row = 0; row < 24; row++) {
    for (let column = 0; column < 24; column++) {
      const target = {
        x: bounds.minX + (bounds.maxX - bounds.minX) * (column + 0.5) / 24,
        y: bounds.minY + (bounds.maxY - bounds.minY) * (row + 0.5) / 24,
      };
      const evenodd = originalPolygons.filter((polygon) => contains(polygon, target)).length % 2 === 1;
      const nonzero = convertedPolygons.reduce((sum, polygon) => sum + winding(polygon, target), 0) !== 0;
      if (evenodd !== nonzero) mismatches++;
    }
  }
  if (mismatches) throw new Error("변환 전후 렌더링이 일치하지 않아 사람 검토가 필요합니다.");
  return convertedContent;
}

try {
  return [{ json: {
    event_id: input.event_id + ":conversion",
    submission_id: input.submission_id,
    success: true,
    converted_content: convert(input.svg_content),
    error: null,
  } }];
} catch (error) {
  return [{ json: {
    event_id: input.event_id + ":conversion",
    submission_id: input.submission_id,
    success: false,
    converted_content: null,
    error: error instanceof Error ? error.message : "SVG 변환에 실패했습니다.",
  } }];
}`;

const convertSvg = node({
	type: "n8n-nodes-base.code",
	version: 2,
	config: {
		name: "Convert SVG",
		parameters: {
			mode: "runOnceForAllItems",
			language: "javaScript",
			jsCode: conversionCode,
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
				"{{ { event_id: $('Receive SVG Submission').item.json.body.event_id + ':conversion-failure', recipient_id: $('Receive SVG Submission').item.json.body.contributor_id, kind: 'conversion_failure', reference_event_id: $('Convert SVG').item.json.event_id, detail: $('Convert SVG').item.json.error } }}",
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
