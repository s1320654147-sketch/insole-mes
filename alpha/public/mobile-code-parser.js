function extractQueryPayload(rawValue, keys) {
  const value = String(rawValue || "").trim();
  if (!value || !/^https?:\/\//i.test(value)) return value;
  try {
    const parsedUrl = new URL(value);
    return String(keys.map((key) => parsedUrl.searchParams.get(key)).find(Boolean) || value).trim();
  } catch {
    return value;
  }
}

export function parseWorkOrderCode(rawValue) {
  const value = extractQueryPayload(rawValue, ["workOrder", "order", "code"]);
  if (!value) return null;
  if (!value.includes("|")) {
    return { workOrderId: value, processName: "" };
  }
  const parts = value.split("|").map((part) => part.trim());
  if (parts.length < 2 || parts[0] !== "WO" || !parts[1]) return null;
  return {
    workOrderId: parts[1],
    processName: parts.slice(2).join("|") || "",
  };
}

export function parseBatchCode(rawValue) {
  const value = extractQueryPayload(rawValue, ["batch", "code"]);
  if (!value) return null;
  const parts = value.split("|").map((part) => part.trim());
  if (parts.length < 4 || parts[0] !== "MAT" || !parts[1] || !parts[2]) return null;
  return {
    materialCode: parts[1],
    batchNo: parts[2],
    location: parts.slice(3).join("|") || "",
  };
}
