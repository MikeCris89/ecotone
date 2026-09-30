import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

const NUMERIC_COMPARISONS = new Set(["<", "<=", ">", ">="]);

/**
 * OpenFreeMap Positron's filters compare properties that some tile features lack (road shields'
 * `ref_length`, boundaries' `admin_level`). MapLibre then logs "Expected value to be of type
 * number, but found null instead" and drops the feature. Guarding each such comparison with `has`
 * drops the same features without the error. Other styles pass through unchanged where nothing
 * matches.
 */
export function guardMissingNumbers(style: StyleSpecification): StyleSpecification {
	return {
		...style,
		layers: style.layers.map((layer) =>
			"filter" in layer && layer.filter ? ({ ...layer, filter: guard(layer.filter) } as LayerSpecification) : layer,
		),
	};
}

function guard(node: unknown): unknown {
	if (!Array.isArray(node)) return node;
	if (node.length === 3 && NUMERIC_COMPARISONS.has(node[0])) {
		const keys = [node[1], node[2]].flatMap(propertyKey);
		if (keys.length) return ["all", ...keys.map((key) => ["has", key]), node];
	}
	return node.map(guard);
}

// The property a `["get", key]` expression reads. Legacy filters (["<=", "key", 6]) don't raise
// the error, so they're left alone.
function propertyKey(node: unknown): string[] {
	return Array.isArray(node) && node.length === 2 && node[0] === "get" && typeof node[1] === "string"
		? [node[1]]
		: [];
}
