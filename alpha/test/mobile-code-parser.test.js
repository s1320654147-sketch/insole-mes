import assert from "node:assert/strict";
import test from "node:test";
import { parseBatchCode, parseWorkOrderCode } from "../public/mobile-code-parser.js";

test("mobile work order parser supports raw codes and mobile links", () => {
  assert.deepEqual(parseWorkOrderCode("WO|WO-001|成型 / 压制"), {
    workOrderId: "WO-001",
    processName: "成型 / 压制",
  });
  assert.deepEqual(parseWorkOrderCode("https://mes.example/mobile.html?workOrder=WO-002"), {
    workOrderId: "WO-002",
    processName: "",
  });
  assert.equal(parseWorkOrderCode("MAT|RM-001|BATCH-A|A-01"), null);
  assert.equal(parseWorkOrderCode("WO||成型"), null);
});

test("mobile batch parser supports raw codes, links, and location separators", () => {
  assert.deepEqual(parseBatchCode("MAT|RM-001|BATCH-A|A-01"), {
    materialCode: "RM-001",
    batchNo: "BATCH-A",
    location: "A-01",
  });
  assert.deepEqual(
    parseBatchCode("https://mes.example/mobile.html?batch=MAT%7CRM-002%7CBATCH-B%7CA-01%7CZONE-2"),
    {
      materialCode: "RM-002",
      batchNo: "BATCH-B",
      location: "A-01|ZONE-2",
    }
  );
  assert.equal(parseBatchCode("WO|WO-001|备料"), null);
  assert.equal(parseBatchCode("MAT||BATCH-A|A-01"), null);
  assert.equal(parseBatchCode("MAT|RM-001||A-01"), null);
});

test("batch identity requires material code and batch number together", () => {
  const materials = [
    { code: "RM-A", batchNo: "SAME" },
    { code: "RM-B", batchNo: "SAME" },
  ];
  const parsed = parseBatchCode("MAT|RM-B|SAME|B-02");
  const match = materials.find((item) => item.code === parsed.materialCode && item.batchNo === parsed.batchNo);
  assert.equal(match.code, "RM-B");
});
